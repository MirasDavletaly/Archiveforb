//go:build windows

package main

// Files on demand on Windows (decided 2026-11-20): everything the person can open on the website appears in
// %USERPROFILE%\Company Files, in Explorer's navigation pane like OneDrive. Folders are listed when they are first
// opened, files are downloaded when they are opened (Explorer's "Always keep on this device" and "Free up space"
// work as with OneDrive), and changes on the website show up within a second. What is added, edited, renamed,
// moved or deleted here goes to the website, with the website's rules: read-only stays read-only (a delete or
// rename there is refused), confidential folders never appear.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const cloudSupported = true

// cloudItem is one file or folder as the server lists it (GET /api/agent/cloud[/:id]).
type cloudItem struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Dir      bool   `json:"dir"`
	Size     int64  `json:"size"`
	V        string `json:"v"`
	Modified int64  `json:"modified"`
	Created  int64  `json:"created"`
	ReadOnly bool   `json:"readOnly"`
}

// identity is what Windows keeps with each placeholder: "d|id|ro" for a folder, "f|id|version|ro" for a file.
type identity struct {
	Dir      bool
	ID       int64
	V        string
	ReadOnly bool
}

func (it cloudItem) identity() identity { return identity{it.Dir, it.ID, it.V, it.ReadOnly} }

func (id identity) bytes() []byte {
	ro := "0"
	if id.ReadOnly {
		ro = "1"
	}
	if id.Dir {
		return []byte("d|" + strconv.FormatInt(id.ID, 10) + "|" + ro)
	}
	return []byte("f|" + strconv.FormatInt(id.ID, 10) + "|" + id.V + "|" + ro)
}

func parseIdentity(b []byte) (identity, bool) {
	p := strings.Split(string(b), "|")
	switch {
	case len(p) == 3 && p[0] == "d":
		n, err := strconv.ParseInt(p[1], 10, 64)
		return identity{Dir: true, ID: n, ReadOnly: p[2] == "1"}, err == nil
	case len(p) == 4 && p[0] == "f":
		n, err := strconv.ParseInt(p[1], 10, 64)
		return identity{ID: n, V: p[2], ReadOnly: p[3] == "1"}, err == nil
	}
	return identity{}, false // the sync root itself, or not ours
}

// Cloud is the running files-on-demand provider (one per agent).
type Cloud struct {
	s       *Syncer
	root    string
	key     int64
	mu      sync.Mutex
	dirs    map[int64]string       // folders whose contents are here: id -> full path
	expect  map[string]time.Time   // paths this program itself renames or deletes (lower case): callbacks just agree
	away    map[string]awayFile    // Office "safe save": the original renamed to a temporary name, by original path
	pending map[string]time.Time   // paths changed here, sent once they settle
	cancel  map[int64]bool         // downloads Windows gave up on, by transfer key
	renamed map[string]renamedFile // renamed here and on the website: in sync, not edited
	toFree  map[string]time.Time   // sent to the website, to become cloud-only once no program holds them
}

type renamedFile struct {
	id identity
	at time.Time
}

type awayFile struct {
	id   identity
	temp string
	at   time.Time
}

var theCloud *Cloud // the callbacks below are plain functions; they reach the provider through this

// ---- setting up: register the folder with Windows (Explorer integration) and connect ----

func cloudRoot(cfg Config) string {
	if cfg.CloudRoot != "" {
		return cfg.CloudRoot
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, cfg.name())
}

func syncRootID(cfg Config) string {
	sid := "user"
	if t := windows.GetCurrentProcessToken(); t != 0 {
		if u, err := t.GetTokenUser(); err == nil {
			sid = u.User.Sid.String()
		}
	}
	acct := strings.NewReplacer("!", "_", "\\", "_", "/", "_", ":", "_").Replace(cfg.User)
	return cfg.CloudProvider() + "!" + sid + "!" + acct
}

// registerSyncRoot tells Windows this folder is a cloud folder (navigation pane, status icons, "Free up space").
// StorageProviderSyncRootManager is a WinRT API; PowerShell can call it without any extra component.
func registerSyncRoot(id, root, name string) error {
	exe := exePath()
	script := `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Provider.StorageProviderSyncRootManager, Windows.Storage.Provider, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + `1' } | Select-Object -First 1
$folder = $asTask.MakeGenericMethod([Windows.Storage.StorageFolder]).Invoke($null, @([Windows.Storage.StorageFolder]::GetFolderFromPathAsync(` + psQuote(root) + `))).GetAwaiter().GetResult()
$info = New-Object Windows.Storage.Provider.StorageProviderSyncRootInfo
$info.Id = ` + psQuote(id) + `
$info.Path = $folder
$info.DisplayNameResource = ` + psQuote(name) + `
$info.IconResource = ` + psQuote(exe+",0") + `
$info.HydrationPolicy = 'Full'
$info.HydrationPolicyModifier = 'AutoDehydrationAllowed'
$info.PopulationPolicy = 'Full'
$info.InSyncPolicy = 'Default'
$info.HardlinkPolicy = 'None'
$info.Version = ` + psQuote(version) + `
$info.ShowSiblingsAsGroup = $false
$info.Context = [System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions]::AsBuffer([Text.Encoding]::UTF8.GetBytes(` + psQuote(id) + `))
[Windows.Storage.Provider.StorageProviderSyncRootManager]::Register($info)
'registered'`
	out, err := powershell(script)
	if err != nil || !strings.Contains(out, "registered") {
		return fmt.Errorf("registering the cloud folder: %v %s", err, out)
	}
	return nil
}

// quietDownloadNotices turns off Windows' "<program> is downloading from Company Files" pop-up for this user (the
// person asked for no such question each time a file is opened); files still download as before. It is the same
// switch as Settings → System → Notifications → Automatic file downloads.
func quietDownloadNotices() {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\Windows.System.AppInitiatedDownload`, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetDWordValue("Enabled", 0)
}

func unregisterSyncRoot(id string) error {
	out, err := powershell(`$ErrorActionPreference = 'Stop'
$null = [Windows.Storage.Provider.StorageProviderSyncRootManager, Windows.Storage.Provider, ContentType = WindowsRuntime]
[Windows.Storage.Provider.StorageProviderSyncRootManager]::Unregister(` + psQuote(id) + `)
'done'`)
	if err != nil || !strings.Contains(out, "done") {
		return fmt.Errorf("%v %s", err, out)
	}
	return nil
}

// runCloud keeps the provider running until ctx ends.
func (s *Syncer) runCloud(stop <-chan struct{}) {
	cfg := s.app.config()
	c := &Cloud{s: s, root: cloudRoot(cfg), dirs: map[int64]string{}, expect: map[string]time.Time{}, away: map[string]awayFile{}, pending: map[string]time.Time{}, cancel: map[int64]bool{}, renamed: map[string]renamedFile{}, toFree: map[string]time.Time{}}
	if err := os.MkdirAll(c.root, 0o755); err != nil {
		s.app.setStatus("Cannot make the folder " + c.root + ": " + err.Error())
		return
	}
	id := syncRootID(cfg)
	if cfg.CloudRegistered != id+"|"+c.root {
		name := cfg.name()
		if os.Getenv("COMPANYFILES_CLOUD_PROVIDER") != "" {
			name += " (test)" // a test registration is never mistaken for the real folder
		}
		if err := registerSyncRoot(id, c.root, name); err != nil {
			log.Printf("files on demand: %v", err)
			s.app.setStatus("Files on demand could not start: " + err.Error())
			return
		}
		_ = s.app.update(func(cf *Config) { cf.CloudRegistered = id + "|" + c.root })
	}
	quietDownloadNotices()
	c.loadDirs()
	theCloud = c
	key, err := connectSyncRoot(c.root, cloudCallbacks())
	if err != nil {
		log.Printf("files on demand: connect: %v", err)
		s.app.setStatus("Files on demand could not start: " + err.Error())
		theCloud = nil
		return
	}
	c.key = key
	log.Printf("files on demand: %s connected", c.root)
	defer func() {
		disconnectSyncRoot(key)
		theCloud = nil
	}()
	go c.watch(stop)
	c.refreshAll()
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			c.refreshAll()
		case folders := <-s.cloudKick:
			c.refresh(folders)
		}
	}
}

func (s *Syncer) api() *API {
	cfg := s.app.config()
	return newAPI(cfg.Server, cfg.Token)
}

// ---- remembering which folders are here ----

func (c *Cloud) statePath() string { return filepath.Join(c.s.app.dir, "cloud.json") }

func (c *Cloud) loadDirs() {
	var st struct {
		Root string           `json:"root"`
		Dirs map[int64]string `json:"dirs"`
	}
	if b, err := os.ReadFile(c.statePath()); err == nil && json.Unmarshal(b, &st) == nil && st.Root == c.root && st.Dirs != nil {
		c.dirs = st.Dirs
	}
}

func (c *Cloud) saveDirs() {
	c.mu.Lock()
	b, _ := json.Marshal(struct {
		Root string           `json:"root"`
		Dirs map[int64]string `json:"dirs"`
	}{c.root, c.dirs})
	c.mu.Unlock()
	_ = os.WriteFile(c.statePath(), b, 0o600)
}

func (c *Cloud) noteDir(id int64, path string) {
	c.mu.Lock()
	c.dirs[id] = path
	c.mu.Unlock()
	c.saveDirs()
}

// movedDir: a folder here was renamed or moved; what is recorded inside it follows.
func (c *Cloud) movedDir(from, to string) {
	c.mu.Lock()
	for id, p := range c.dirs {
		if strings.EqualFold(p, from) {
			c.dirs[id] = to
		} else if len(p) > len(from) && strings.EqualFold(p[:len(from)+1], from+`\`) {
			c.dirs[id] = to + p[len(from):]
		}
	}
	c.mu.Unlock()
	c.saveDirs()
}

func (c *Cloud) expectOp(path string) {
	c.mu.Lock()
	c.expect[strings.ToLower(path)] = time.Now()
	c.mu.Unlock()
}

// expected: this program itself is renaming or deleting path (or a folder above it).
func (c *Cloud) expected(path string) bool {
	l := strings.ToLower(path)
	c.mu.Lock()
	defer c.mu.Unlock()
	for p, t := range c.expect {
		if time.Since(t) > 30*time.Second {
			delete(c.expect, p)
			continue
		}
		if l == p || strings.HasPrefix(l, p+`\`) {
			return true
		}
	}
	return false
}

// ---- placeholders ----

func filetime(ms int64) int64 {
	if ms <= 0 {
		ms = time.Now().UnixMilli()
	}
	return ms*10000 + 116444736000000000 // 100 ns since 1601
}

func metaFor(it cloudItem) cfFsMetadata {
	attrs := uint32(fileAttributeNormal)
	if it.Dir {
		attrs = fileAttributeDirectory
	} else if it.ReadOnly {
		attrs = fileAttributeReadonly
	}
	t := filetime(it.Modified)
	return cfFsMetadata{BasicInfo: fileBasicInfo{CreationTime: filetime(it.Created), LastAccessTime: t, LastWriteTime: t, ChangeTime: t, FileAttributes: attrs}, FileSize: it.Size}
}

// placeholders builds Windows' structures for a listing; keep the returned holder alive until they are used.
func placeholders(items []cloudItem) ([]cfPlaceholderCreateInfo, [][]byte, [][]uint16) {
	infos := make([]cfPlaceholderCreateInfo, 0, len(items))
	ids, names := make([][]byte, 0, len(items)), make([][]uint16, 0, len(items))
	for _, it := range items {
		name, err := windows.UTF16FromString(it.Name)
		if err != nil {
			continue
		}
		id := it.identity().bytes()
		ids, names = append(ids, id), append(names, name)
		infos = append(infos, cfPlaceholderCreateInfo{RelativeFileName: &name[0], FsMetadata: metaFor(it), FileIdentity: unsafe.Pointer(&id[0]), FileIdentityLength: uint32(len(id)), Flags: cfPlaceholderMarkInSync})
	}
	return infos, ids, names
}

func (c *Cloud) list(folder int64) ([]cloudItem, error) {
	var out []cloudItem
	path := "/api/agent/cloud"
	if folder != 0 {
		path += "/" + strconv.FormatInt(folder, 10)
	}
	err := c.s.api().call("GET", path, nil, &out)
	return out, err
}

// ---- callbacks from Windows ----

func cloudCallbacks() []cfCallbackRegistration {
	return []cfCallbackRegistration{
		{Type: cfCallbackFetchPlaceholders, Callback: syscall.NewCallback(onFetchPlaceholders)},
		{Type: cfCallbackFetchData, Callback: syscall.NewCallback(onFetchData)},
		{Type: cfCallbackCancelFetchData, Callback: syscall.NewCallback(onCancelFetchData)},
		{Type: cfCallbackNotifyDelete, Callback: syscall.NewCallback(onNotifyDelete)},
		{Type: cfCallbackNotifyRename, Callback: syscall.NewCallback(onNotifyRename)},
		{Type: cfCallbackNotifyCloseComplete, Callback: syscall.NewCallback(onCloseCompletion)},
	}
}

func fullPath(info *cfCallbackInfo) string {
	return windows.UTF16PtrToString(info.VolumeDosName) + info.path()
}

// A folder is opened for the first time: list it from the website.
func onFetchPlaceholders(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	c := theCloud
	if c == nil {
		_ = cfTransferPlaceholders(info, nil, statusUnsuccessful)
		return 0
	}
	id, _ := parseIdentity(info.identity()) // the root folder has none: its listing is the top level
	dir := fullPath(info)
	items, err := c.list(id.ID)
	if err != nil {
		log.Printf("files on demand: cannot list %s: %v", dir, err)
		_ = cfTransferPlaceholders(info, nil, statusUnsuccessful)
		return 0
	}
	infos, ids, names := placeholders(items)
	if err := cfTransferPlaceholders(info, infos, statusSuccess); err != nil {
		log.Printf("files on demand: listing %s: %v", dir, err)
	}
	runtime.KeepAlive(ids)
	runtime.KeepAlive(names)
	if id.ID != 0 {
		c.noteDir(id.ID, dir)
	} else {
		c.noteDir(0, dir)
	}
	return 0
}

// A file is opened: download it from the website, in chunks, as Windows asks.
func onFetchData(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	c := theCloud
	id, ok := parseIdentity(info.identity())
	offset, length := params.i64(16), params.i64(24) // RequiredFileOffset, RequiredLength
	if c == nil || !ok || id.Dir {
		_ = cfFailData(info, offset, length)
		return 0
	}
	c.mu.Lock()
	delete(c.cancel, info.TransferKey) // the key belongs to the file, not to one request: an old cancel must not stop this one
	c.mu.Unlock()
	if at, err := c.download(info, id, offset); err != nil {
		log.Printf("files on demand: cannot download %s: %v", fullPath(info), err)
		_ = cfFailData(info, at, max(offset+length-at, info.FileSize-at))
		if strings.Contains(err.Error(), "newer version") {
			go c.refresh([]int64{-1}) // the placeholder is out of date: bring the folder up to date
		}
	}
	return 0
}

// download returns how far it got, so a failure names the rest of the range.
func (c *Cloud) download(info *cfCallbackInfo, id identity, offset int64) (int64, error) {
	req, err := http.NewRequest("GET", c.s.api().Server+"/api/agent/cloud/"+strconv.FormatInt(id.ID, 10)+"/content", nil)
	if err != nil {
		return offset, err
	}
	if offset > 0 {
		req.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	api := c.s.api()
	api.http.Timeout = 0
	res, err := api.do(req)
	if err != nil {
		return offset, err
	}
	defer res.Body.Close()
	if v := res.Header.Get("X-Version"); v != "" && v != id.V {
		return offset, errors.New("the website has a newer version")
	}
	buf := make([]byte, transferChunk)
	at := offset
	for {
		c.mu.Lock()
		stop := c.cancel[info.TransferKey]
		c.mu.Unlock()
		if stop {
			return at, errors.New("cancelled")
		}
		n, rerr := io.ReadFull(res.Body, buf)
		if n > 0 {
			if err := cfTransferData(info, at, buf[:n], statusSuccess); err != nil {
				return at, err
			}
			at += int64(n)
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			return at, rerr
		}
	}
	if at != info.FileSize {
		return at, fmt.Errorf("got %d of %d bytes", at, info.FileSize)
	}
	return at, nil
}

func onCancelFetchData(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	if c := theCloud; c != nil {
		c.mu.Lock()
		c.cancel[info.TransferKey] = true
		c.mu.Unlock()
	}
	return 0
}

// Something here is being deleted: the same goes to the website's trash first (refused where it is read only).
func onNotifyDelete(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	c := theCloud
	path := fullPath(info)
	id, ok := parseIdentity(info.identity())
	switch {
	case c == nil:
		_ = cfAck(info, cfOpAckDelete, statusAccessDenied)
	case !ok || c.expected(path):
		_ = cfAck(info, cfOpAckDelete, statusSuccess)
	case c.isAway(id):
		_ = cfAck(info, cfOpAckDelete, statusSuccess) // the old copy of an Office save: the file lives on as a version
	case id.ReadOnly:
		c.s.app.setStatus("You can only view \"" + filepath.Base(path) + "\": it was not deleted.")
		_ = cfAck(info, cfOpAckDelete, statusAccessDenied)
	default:
		q := ""
		if !id.Dir {
			q = "?base=" + url.QueryEscape(id.V)
		}
		err := c.s.api().call("DELETE", "/api/agent/cloud/"+strconv.FormatInt(id.ID, 10)+q, nil, nil)
		if err != nil && statusOf(err) != 404 {
			log.Printf("files on demand: the website did not delete %s: %v", path, err)
			c.s.app.setStatus("\"" + filepath.Base(path) + "\" was not deleted: " + errText(err))
			_ = cfAck(info, cfOpAckDelete, statusAccessDenied)
			return 0
		}
		log.Printf("files on demand: deleted here and moved to the website's trash: %s", path)
		_ = cfAck(info, cfOpAckDelete, statusSuccess)
	}
	return 0
}

func errText(err error) string {
	var h *httpError
	if errors.As(err, &h) && h.Msg != "" {
		return h.Msg
	}
	return "the website cannot be reached"
}

// Something here is being renamed or moved: the same item is renamed or moved on the website first.
func onNotifyRename(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	c := theCloud
	flags := params.u32(8)
	target := params.str(16)
	if len(target) > 0 && target[0] == '\\' {
		target = windows.UTF16PtrToString(info.VolumeDosName) + target
	}
	path := fullPath(info)
	id, ok := parseIdentity(info.identity())
	switch {
	case c == nil:
		_ = cfAck(info, cfOpAckRename, statusAccessDenied)
		return 0
	case !ok || c.expected(path):
		_ = cfAck(info, cfOpAckRename, statusSuccess)
		return 0
	case id.ReadOnly:
		c.s.app.setStatus("You can only view \"" + filepath.Base(path) + "\": it was not renamed.")
		_ = cfAck(info, cfOpAckRename, statusAccessDenied)
		return 0
	case flags&cfRenameFlagTargetInScope != 0 && !id.Dir && ignoredName(filepath.Base(target)):
		// An Office "safe save" renames the document to a temporary name, writes the new one and deletes the
		// temporary copy: remember it, so the new file becomes a new version of the same file on the website.
		c.mu.Lock()
		c.away[strings.ToLower(path)] = awayFile{id: id, temp: target, at: time.Now()}
		c.mu.Unlock()
		_ = cfAck(info, cfOpAckRename, statusSuccess)
		return 0
	}
	var err error
	if flags&cfRenameFlagTargetInScope == 0 { // moved out of the cloud folder: it leaves the website too
		q := ""
		if !id.Dir {
			q = "?base=" + url.QueryEscape(id.V)
		}
		err = c.s.api().call("DELETE", "/api/agent/cloud/"+strconv.FormatInt(id.ID, 10)+q, nil, nil)
	} else {
		parent, perr := c.folderIDOf(filepath.Dir(target))
		if perr != nil {
			err = perr
		} else {
			v := url.Values{"parent": {strconv.FormatInt(parent, 10)}, "name": {filepath.Base(target)}}
			if !id.Dir {
				v.Set("base", id.V)
			}
			err = c.s.api().call("POST", "/api/agent/cloud/"+strconv.FormatInt(id.ID, 10)+"/move?"+v.Encode(), nil, nil)
		}
	}
	if err != nil {
		log.Printf("files on demand: the website did not rename %s to %s: %v", path, target, err)
		c.s.app.setStatus("\"" + filepath.Base(path) + "\" was not renamed: " + errText(err))
		_ = cfAck(info, cfOpAckRename, statusAccessDenied)
		return 0
	}
	if id.Dir {
		c.movedDir(path, target)
	}
	c.mu.Lock()
	c.renamed[strings.ToLower(target)] = renamedFile{id: id, at: time.Now()}
	c.mu.Unlock()
	log.Printf("files on demand: renamed or moved here and on the website: %s → %s", path, target)
	_ = cfAck(info, cfOpAckRename, statusSuccess)
	return 0
}

// folderIDOf: the website folder a folder here stands for (refused for the top level, which holds the sections).
func (c *Cloud) folderIDOf(dir string) (int64, error) {
	if strings.EqualFold(filepath.Clean(dir), filepath.Clean(c.root)) {
		return 0, &httpError{403, "the top level of " + c.s.app.config().name() + " holds its sections; put files inside one of them"}
	}
	ph, err := getPlaceholderInfo(dir)
	if err != nil {
		return 0, fmt.Errorf("the folder %s is not on the website yet", dir)
	}
	id, ok := parseIdentity(ph.Identity)
	if !ok || !id.Dir {
		return 0, fmt.Errorf("the folder %s is not on the website yet", dir)
	}
	if id.ReadOnly {
		return 0, &httpError{403, "you can only view that folder"}
	}
	return id.ID, nil
}

func (c *Cloud) isAway(id identity) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, a := range c.away {
		if a.id.ID == id.ID {
			return true
		}
	}
	return false
}

// A file was closed: if it was written to, it goes up as a new version once it settles.
func onCloseCompletion(info *cfCallbackInfo, params *cfCallbackParams) uintptr {
	if c := theCloud; c != nil && params.u32(8)&cfCloseFlagDeleted == 0 {
		p := fullPath(info)
		c.mu.Lock()
		_, waiting := c.toFree[p]
		c.mu.Unlock()
		if waiting {
			go func() { time.Sleep(time.Second); c.free(p) }() // closed by the program that held it
		}
		c.touch(p)
	}
	return 0
}

// ---- what changes here goes to the website ----

func (c *Cloud) touch(path string) {
	c.mu.Lock()
	c.pending[path] = time.Now()
	c.mu.Unlock()
}

// watch notices files and folders made or changed in the cloud folder (Windows tells about every change), and sends
// each once it has stood still for 2 seconds (a document being saved or copied is not sent half-way).
func (c *Cloud) watch(stop <-chan struct{}) {
	go c.watchDir(stop)
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		var ready []string
		c.mu.Lock()
		for p, at := range c.pending {
			if time.Since(at) >= 2*time.Second {
				ready = append(ready, p)
				delete(c.pending, p)
			}
		}
		var retry []string
		for p, at := range c.toFree {
			if time.Since(at) > 10*time.Second {
				retry = append(retry, p)
				c.toFree[p] = time.Now()
			}
		}
		for k, a := range c.away { // a temporary copy whose new file never came: it was a real delete or rename
			if time.Since(a.at) > 2*time.Minute {
				delete(c.away, k)
			}
		}
		c.mu.Unlock()
		for _, p := range ready {
			c.sendUp(p)
		}
		for _, p := range retry {
			c.free(p)
		}
	}
}

func (c *Cloud) watchDir(stop <-chan struct{}) {
	p, _ := windows.UTF16PtrFromString(c.root)
	h, err := windows.CreateFile(p, windows.FILE_LIST_DIRECTORY, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		log.Printf("files on demand: cannot watch %s: %v", c.root, err)
		return
	}
	go func() { <-stop; windows.CloseHandle(h) }()
	buf := make([]byte, 64<<10)
	for {
		var n uint32
		err := windows.ReadDirectoryChanges(h, &buf[0], uint32(len(buf)), true,
			windows.FILE_NOTIFY_CHANGE_FILE_NAME|windows.FILE_NOTIFY_CHANGE_DIR_NAME|windows.FILE_NOTIFY_CHANGE_LAST_WRITE|windows.FILE_NOTIFY_CHANGE_SIZE|windows.FILE_NOTIFY_CHANGE_ATTRIBUTES, &n, nil, 0)
		if err != nil {
			return // closed on stop
		}
		for off := uint32(0); n > 0; {
			e := (*windows.FileNotifyInformation)(unsafe.Pointer(&buf[off]))
			name := windows.UTF16ToString(unsafe.Slice(&e.FileName, e.FileNameLength/2))
			if e.Action == windows.FILE_ACTION_ADDED || e.Action == windows.FILE_ACTION_MODIFIED || e.Action == windows.FILE_ACTION_RENAMED_NEW_NAME {
				c.touch(filepath.Join(c.root, name))
			}
			if e.NextEntryOffset == 0 {
				break
			}
			off += e.NextEntryOffset
		}
	}
}

// applyPin does what Explorer's "Always keep on this device" and "Free up space" ask for: Windows only marks the
// file (pinned or unpinned); fetching or freeing it is the sync program's job, as with OneDrive.
func (c *Cloud) applyPin(path string, st os.FileInfo) {
	a, ok := st.Sys().(*syscall.Win32FileAttributeData)
	if !ok {
		return
	}
	switch {
	case a.FileAttributes&fileAttributePinned != 0 && cloudOnly(st):
		go func() {
			if err := hydratePlaceholder(path); err != nil {
				log.Printf("files on demand: cannot keep %s on this device: %v", path, err)
			} else {
				log.Printf("files on demand: always kept on this device: %s", path)
			}
		}()
	case a.FileAttributes&fileAttributeUnpinned != 0 && !cloudOnly(st):
		c.free(path)
	}
}

// cloudOnly: the file's data is not on this computer (reading it would download it first).
func cloudOnly(st os.FileInfo) bool {
	a, ok := st.Sys().(*syscall.Win32FileAttributeData)
	return ok && a.FileAttributes&(fileAttributeRecallOnAccess|fileAttributeRecallOnOpen) != 0
}

// sendUp looks at one changed path: a new file or folder is created on the website and becomes a placeholder; an
// edited file goes up as a new version (the version it was based on is checked).
func (c *Cloud) sendUp(path string) {
	st, err := os.Lstat(path)
	if err != nil || ignoredName(filepath.Base(path)) || st.Mode()&os.ModeSymlink != 0 {
		return
	}
	if ph, err := getPlaceholderInfo(path); err == nil {
		id, ok := parseIdentity(ph.Identity)
		if ok && !id.Dir && ph.InSync == cfInSyncStateInSync {
			c.applyPin(path, st)
		}
		if !ok || ph.InSync == cfInSyncStateInSync {
			return
		}
		c.mu.Lock()
		r, wasRenamed := c.renamed[strings.ToLower(path)]
		delete(c.renamed, strings.ToLower(path))
		c.mu.Unlock()
		if id.Dir || (wasRenamed && r.id.ID == id.ID) || cloudOnly(st) {
			_ = markInSync(path, ph.Identity) // renamed, or only in the cloud: nothing here was edited
			return
		}
		c.uploadVersion(path, id) // an edited file
		return
	}
	parentDir := filepath.Dir(path)
	parent, err := c.folderIDOf(parentDir)
	if err != nil {
		log.Printf("files on demand: %s stays here only: %v", path, err)
		c.s.app.setStatus("\"" + filepath.Base(path) + "\" is only on this computer: " + errText(err))
		return
	}
	api := c.s.api()
	if st.IsDir() {
		var it cloudItem
		if err := api.call("POST", "/api/agent/cloud/"+strconv.FormatInt(parent, 10)+"/folders?name="+url.QueryEscape(st.Name()), nil, &it); err != nil {
			log.Printf("files on demand: the website did not take folder %s: %v", path, err)
			return
		}
		if err := convertToPlaceholder(path, it.identity().bytes(), true); err != nil {
			log.Printf("files on demand: %s: %v", path, err)
			return
		}
		c.noteDir(it.ID, path)
		log.Printf("files on demand: new folder here, made on the website: %s", path)
		entries, _ := os.ReadDir(path) // a whole folder copied in: what is inside goes too
		for _, e := range entries {
			c.sendUp(filepath.Join(path, e.Name()))
		}
		return
	}
	c.mu.Lock()
	away, replacing := c.away[strings.ToLower(path)]
	delete(c.away, strings.ToLower(path))
	c.mu.Unlock()
	if replacing { // an Office save: the new file is a new version of the one it replaced
		c.uploadVersion(path, away.id)
		return
	}
	it, err := c.upload(path, parent, "", "")
	if err != nil {
		log.Printf("files on demand: the website did not take %s: %v", path, err)
		c.s.app.setStatus("\"" + filepath.Base(path) + "\" is only on this computer: " + errText(err))
		return
	}
	if err := convertToPlaceholder(path, it.identity().bytes(), false); err != nil {
		log.Printf("files on demand: %s: %v", path, err)
		return
	}
	log.Printf("files on demand: new file here, sent to the website: %s", path)
	c.free(path)
}

// free makes a file that was just sent to the website cloud-only (decided 2026-11-20: what is made or edited here
// is kept on the website, and here only as its icon; opening it downloads it again). Files and folders marked
// "Always keep on this device" stay. A file still open in a program is freed when it is closed.
func (c *Cloud) free(path string) {
	st, err := os.Lstat(path)
	if err != nil || cloudOnly(st) {
		return
	}
	if a, ok := st.Sys().(*syscall.Win32FileAttributeData); ok && a.FileAttributes&fileAttributePinned != 0 {
		return
	}
	if err := updatePlaceholder(path, nil, nil, true); err != nil {
		c.mu.Lock()
		c.toFree[path] = time.Now()
		c.mu.Unlock()
		return
	}
	c.mu.Lock()
	delete(c.toFree, path)
	c.mu.Unlock()
	log.Printf("files on demand: %s is only in the cloud now (opening it downloads it)", path)
}

func (c *Cloud) uploadVersion(path string, id identity) {
	parent, err := c.folderIDOf(filepath.Dir(path))
	if err != nil {
		log.Printf("files on demand: %s: %v", path, err)
		return
	}
	it, err := c.upload(path, parent, strconv.FormatInt(id.ID, 10), id.V)
	switch {
	case err == nil:
		if ph, perr := getPlaceholderInfo(path); perr == nil && len(ph.Identity) > 0 {
			_ = markInSync(path, it.identity().bytes())
		} else if err := convertToPlaceholder(path, it.identity().bytes(), false); err != nil {
			log.Printf("files on demand: %s: %v", path, err)
		}
		log.Printf("files on demand: edited here, new version on the website: %s", path)
		c.free(path)
	case statusOf(err) == 409:
		// Changed on the website meanwhile: this edit is kept as "name (conflict, PC)" and sent as a file of its own;
		// the website's version comes back under the name.
		ext := filepath.Ext(path)
		conflict := uniquePath(strings.TrimSuffix(path, ext) + " (conflict, " + computerName() + ")" + ext)
		c.expectOp(path)
		if err := revertPlaceholder(path); err == nil && os.Rename(path, conflict) == nil {
			c.touch(conflict)
			go c.refresh([]int64{parent})
		}
	default:
		log.Printf("files on demand: the website did not take the new version of %s: %v", path, err)
		c.s.app.setStatus("The changes to \"" + filepath.Base(path) + "\" are only on this computer: " + errText(err))
	}
}

func (c *Cloud) upload(path string, folder int64, id, base string) (cloudItem, error) {
	var it cloudItem
	f, err := os.Open(path)
	if err != nil {
		return it, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return it, err
	}
	q := url.Values{"name": {filepath.Base(path)}}
	if id != "" {
		q = url.Values{"id": {id}, "base": {base}}
	}
	err = c.s.api().upload("PUT", "/api/agent/cloud/"+strconv.FormatInt(folder, 10)+"/files?"+q.Encode(), f, st.Size(), &it)
	return it, err
}

// ---- what changes on the website shows up here ----

// refresh brings the folders here that the website says changed up to date (-1 or none known: all of them).
func (c *Cloud) refresh(folders []int64) {
	c.mu.Lock()
	todo := map[int64]string{}
	for _, f := range folders {
		if f == -1 {
			for id, p := range c.dirs {
				todo[id] = p
			}
			break
		}
		if p, ok := c.dirs[f]; ok {
			todo[f] = p
		}
	}
	c.mu.Unlock()
	if len(todo) == 0 {
		log.Printf("files on demand: website changes in folders not opened here (%v)", folders)
	}
	for id, p := range todo {
		c.reconcile(id, p)
	}
}

func (c *Cloud) refreshAll() {
	c.mu.Lock()
	_, rootListed := c.dirs[0]
	c.mu.Unlock()
	if !rootListed {
		return // nothing listed here yet: Windows asks when the folder is first opened
	}
	c.refresh([]int64{-1})
}

// reconcile makes one folder here match the website's listing.
func (c *Cloud) reconcile(folder int64, dir string) {
	items, err := c.list(folder)
	if err != nil {
		if statusOf(err) == 403 || statusOf(err) == 404 { // gone, or no longer open to this person
			c.mu.Lock()
			delete(c.dirs, folder)
			c.mu.Unlock()
			c.saveDirs()
		}
		return
	}
	entries, err := listOnDisk(dir)
	if err != nil {
		return
	}
	type here struct {
		name string
		id   identity
		ph   *placeholderInfo
		attr uint32
	}
	byID := map[int64]here{}
	names := map[string]bool{}
	for _, e := range entries {
		name := windows.UTF16ToString(e.FileName[:])
		names[strings.ToLower(name)] = true
		ph, err := getPlaceholderInfo(filepath.Join(dir, name))
		if err != nil {
			continue // made here and not sent yet: the watcher takes care of it
		}
		if id, ok := parseIdentity(ph.Identity); ok {
			byID[id.ID] = here{name, id, ph, e.FileAttributes}
		}
	}
	var create []cloudItem
	seen := map[int64]bool{}
	for _, it := range items {
		seen[it.ID] = true
		h, ok := byID[it.ID]
		if !ok {
			if !names[strings.ToLower(it.Name)] {
				create = append(create, it)
			}
			continue
		}
		cur := filepath.Join(dir, h.name)
		if h.name != it.Name { // renamed on the website
			to := filepath.Join(dir, it.Name)
			if !names[strings.ToLower(it.Name)] || strings.EqualFold(h.name, it.Name) {
				c.expectOp(cur)
				if renameHere(cur, to) == nil {
					if it.Dir {
						c.movedDir(cur, to)
					}
					cur = to
					_ = markInSync(cur, h.id.bytes()) // a rename clears the mark; nothing was edited
				}
			}
		}
		if !it.Dir && h.id.V != it.V { // changed on the website
			if h.ph.InSync != cfInSyncStateInSync && h.attr&(fileAttributeRecallOnAccess|fileAttributeRecallOnOpen) == 0 {
				c.uploadVersion(cur, h.id) // edited here too: the conflict handling keeps both
				continue
			}
			meta := metaFor(it)
			if err := updatePlaceholder(cur, &meta, it.identity().bytes(), true); err != nil {
				log.Printf("files on demand: cannot update %s: %v", cur, err)
			} else if log.Printf("files on demand: changed on the website, updated here: %s", cur); h.attr&fileAttributePinned != 0 {
				go hydratePlaceholder(cur) // "Always keep on this device": fetch the new version now
			}
		}
	}
	for id, h := range byID {
		if seen[id] {
			continue
		}
		cur := filepath.Join(dir, h.name) // deleted on the website (or moved out of this folder)
		if !h.id.Dir && h.ph.InSync != cfInSyncStateInSync && h.attr&(fileAttributeRecallOnAccess|fileAttributeRecallOnOpen) == 0 {
			_ = revertPlaceholder(cur) // edited here: kept, and sent again as a file of its own
			c.touch(cur)
			continue
		}
		c.expectOp(cur)
		if h.id.Dir {
			_ = os.RemoveAll(cur)
		} else {
			_ = os.Remove(cur)
		}
	}
	if len(create) > 0 {
		infos, ids, names := placeholders(create)
		if err := createPlaceholders(dir, infos); err != nil {
			log.Printf("files on demand: cannot add new items to %s: %v", dir, err)
		}
		runtime.KeepAlive(ids)
		runtime.KeepAlive(names)
	}
}

// ---- stopping: when this computer is disconnected or the program removed ----

// cloudTeardown unregisters the cloud folder. Files that are on this computer stay as ordinary files; the ones that
// were only in the cloud (not downloaded) are removed, as they could not be opened any more.
func cloudTeardown(cfg Config) {
	if cfg.CloudRegistered == "" {
		return
	}
	parts := strings.SplitN(cfg.CloudRegistered, "|", 2)
	root := cloudRoot(cfg)
	if len(parts) == 2 {
		root = parts[1]
	}
	var walk func(dir string)
	walk = func(dir string) {
		entries, _ := listOnDisk(dir)
		for _, e := range entries {
			p := filepath.Join(dir, windows.UTF16ToString(e.FileName[:]))
			if e.FileAttributes&fileAttributeDirectory != 0 {
				walk(p)
				_ = revertPlaceholder(p)
				_ = os.Remove(p) // only when empty
				continue
			}
			if e.FileAttributes&(fileAttributeRecallOnAccess|fileAttributeRecallOnOpen) != 0 {
				_ = os.Remove(p)
			} else {
				_ = revertPlaceholder(p)
			}
		}
	}
	walk(root)
	if err := unregisterSyncRoot(parts[0]); err != nil {
		_ = unregisterSyncRootPath(root)
	}
	log.Printf("files on demand: %s is an ordinary folder again", root)
}
