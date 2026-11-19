package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The person's "My files" on the website and <folder>/My files on this computer are kept the same while the agent
// runs, both ways, files and folders (decided 2026-11-19):
//   - website → here: new and changed files are downloaded (a change replaces the copy), new folders are made,
//     renamed and moved files and folders follow, deleted ones go to this computer's trash. Files that were there
//     before this computer was connected are not copied.
//   - here → website: new files and folders are uploaded (an edit becomes a new version), renames and moves are
//     done on the same item there, deletions go to the website's trash.
//
// Nothing is lost on a conflict: a copy edited here while the website changed is kept as "name (conflict, PC)".
// The server only says "My files changed"; the agent compares the list with what it recorded (mirror.json), and
// looks at the folder every 3 seconds, so it also catches up after being off.
const mirrorDir = "My files"

type mirrorEntry struct {
	Path  string `json:"path"` // relative to <folder>/My files, "/"-separated
	V     string `json:"v"`    // content version on the server
	Size  int64  `json:"size"` // size and time of the copy as saved: anything else means it was edited here
	MTime int64  `json:"mtime"`
}

type mirrorState struct {
	Root    string                 `json:"root"`    // the folder and account this belongs to: another folder or
	Account string                 `json:"account"` // account starts afresh (and never deletes the other's copies)
	Files   map[string]mirrorEntry `json:"files"`
	Dirs    map[string]string      `json:"dirs"`              // folder id -> path
	Restore bool                   `json:"restore,omitempty"` // most of the copy vanished here: bring it back from the website
}

type mirrorFile struct {
	ID       int64  `json:"id"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	V        string `json:"v"`
	Modified int64  `json:"modified"`
}

type mirrorFolder struct {
	ID      int64  `json:"id"`
	Path    string `json:"path"`
	Created int64  `json:"created"`
}

func (a *App) mirrorPath() string { return filepath.Join(a.dir, "mirror.json") }

func (a *App) loadMirror(root, account string) mirrorState {
	var st mirrorState
	if b, err := os.ReadFile(a.mirrorPath()); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Root != root || st.Account != account || st.Files == nil {
		st = mirrorState{Root: root, Account: account, Files: map[string]mirrorEntry{}}
	}
	if st.Dirs == nil {
		st.Dirs = map[string]string{}
	}
	return st
}

func (a *App) saveMirror(st mirrorState) error {
	b, _ := json.Marshal(st)
	tmp := a.mirrorPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.mirrorPath())
}

// rebase: a folder moved from one path to another, and everything recorded inside it with it.
func (st *mirrorState) rebase(from, to string) {
	pre := from + "/"
	for id, e := range st.Files {
		if strings.HasPrefix(e.Path, pre) {
			e.Path = to + "/" + e.Path[len(pre):]
			st.Files[id] = e
		}
	}
	for id, p := range st.Dirs {
		if p == from {
			st.Dirs[id] = to
		} else if strings.HasPrefix(p, pre) {
			st.Dirs[id] = to + "/" + p[len(pre):]
		}
	}
}

// untouched: the copy is still exactly as the agent saved it.
func untouched(p string, e mirrorEntry) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Size() == e.Size && st.ModTime().UnixMilli() == e.MTime
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

func isDir(p string) bool {
	st, err := os.Lstat(p)
	return err == nil && st.IsDir()
}

func local(root, rel string) string { return filepath.Join(root, filepath.FromSlash(rel)) }

func depth(rel string) int { return strings.Count(rel, "/") }

func parentOf(rel string) string {
	if i := strings.LastIndex(rel, "/"); i >= 0 {
		return rel[:i]
	}
	return ""
}

// renameHere renames a file or folder, also when only the letter case changes (which Windows and macOS would
// otherwise ignore, as the names count as the same).
func renameHere(from, to string) error {
	if strings.EqualFold(from, to) && from != to {
		tmp := from + ".companyfiles-rename"
		if err := os.Rename(from, tmp); err != nil {
			return err
		}
		from = tmp
	}
	return os.Rename(from, to)
}

// mirror brings both sides up to date once.
func (s *Syncer) mirror(ctx context.Context) error {
	s.mbusy.Lock()
	defer s.mbusy.Unlock()
	s.initLocal()
	cfg := s.app.config()
	api := newAPI(cfg.Server, cfg.Token)
	var list struct {
		Since int64          `json:"since"`
		Files []mirrorFile   `json:"files"`
		Dirs  []mirrorFolder `json:"dirs"`
	}
	if err := api.call("GET", "/api/agent/mirror", nil, &list); err != nil {
		if statusOf(err) == 401 {
			return errUnpaired
		}
		return err
	}
	root := filepath.Join(cfg.folder(), mirrorDir)
	st := s.app.loadMirror(root, cfg.Server+" "+cfg.User)
	if _, err := os.Stat(root); err != nil && len(st.Files)+len(st.Dirs) > 0 {
		// The folder vanished (deleted or moved by hand): nothing is deleted on the website; it is brought back.
		st.Restore = true
	}
	var failed error
	note := func(err error) {
		if err != nil && failed == nil {
			failed = err
		}
	}

	// 1. Folders from the website, parents first. A renamed or moved one is renamed here in one step, with what is
	//    inside; a new one is made; one that is already here is adopted.
	sort.Slice(list.Dirs, func(i, j int) bool { return depth(list.Dirs[i].Path) < depth(list.Dirs[j].Path) })
	onServer := map[string]bool{}
	for _, d := range list.Dirs {
		id := strconv.FormatInt(d.ID, 10)
		onServer[id] = true
		target, err := safeJoin(root, d.Path)
		if err != nil {
			log.Printf("my files: refused unsafe folder path %q", d.Path)
			continue
		}
		p0, tracked := st.Dirs[id]
		switch {
		case tracked && p0 != d.Path:
			from := local(root, p0)
			if isDir(from) && (!isDir(target) || strings.EqualFold(from, target)) {
				if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil || !insideRoot(root, filepath.Dir(target)) {
					note(fmt.Errorf("%s: cannot make its folder", d.Path))
					continue
				}
				if err := renameHere(from, target); err != nil {
					note(fmt.Errorf("%s: %w", d.Path, err))
					continue
				}
				log.Printf("my files: folder renamed or moved on the website: %s → %s", p0, d.Path)
			} else if err := os.MkdirAll(target, 0o755); err != nil {
				note(err)
				continue
			}
			st.rebase(p0, d.Path)
		case tracked: // recorded; if it was deleted here, the look at this computer below handles it
			if st.Restore && !isDir(target) {
				_ = os.MkdirAll(target, 0o755)
			}
		default:
			if !isDir(target) {
				if d.Created <= list.Since {
					continue // there before this computer was connected: made here only when files need it
				}
				if err := os.MkdirAll(target, 0o755); err != nil || !insideRoot(root, target) {
					note(fmt.Errorf("%s: cannot make it", d.Path))
					continue
				}
				log.Printf("my files: new folder from the website: %s", d.Path)
			}
			st.Dirs[id] = d.Path
		}
	}

	// 2. Files from the website.
	seen := map[string]bool{}
	todo, done := 0, 0
	for _, f := range list.Files {
		if e, ok := st.Files[strconv.FormatInt(f.ID, 10)]; (ok && (e.V != f.V || e.Path != f.Path)) || (!ok && f.Modified > list.Since) {
			todo++
		}
	}
	for _, f := range list.Files {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		id := strconv.FormatInt(f.ID, 10)
		seen[id] = true
		e, known := st.Files[id]
		if !known && f.Modified <= list.Since {
			continue // there before this computer was connected: not copied (it can be sent with Enter)
		}
		if known && e.Path != f.Path { // renamed or moved on the website
			if moved, err := mirrorMove(root, e, f.Path); err == nil {
				e.Path = moved
				st.Files[id] = e
			} else {
				log.Printf("my files: cannot move %s to %s: %v", e.Path, f.Path, err)
			}
		}
		if known && e.V == f.V && !(st.Restore && !exists(local(root, e.Path))) {
			continue
		}
		done++
		s.app.setStatus(fmt.Sprintf("My files: saving %d of %d: %s", done, todo, filepath.Base(f.Path)))
		ne, err := s.mirrorSave(api, root, f, e, known)
		switch {
		case err == nil:
			st.Files[id] = ne
			log.Printf("my files: saved %s", ne.Path)
			s.app.saved(local(root, ne.Path))
		case err == errBadPath:
			log.Printf("my files: refused unsafe path %q", f.Path)
		case statusOf(err) == 404: // gone meanwhile; the next round sees it
		case statusOf(err) == 401:
			return errUnpaired
		case statusOf(err) == 429:
			_ = s.app.saveMirror(st)
			return err
		default:
			note(fmt.Errorf("%s: %w", f.Path, err))
		}
		if done%20 == 0 {
			_ = s.app.saveMirror(st) // progress survives a crash or a shutdown
		}
	}

	// 3. Deleted on the website (or no longer in My files): files go to this computer's trash, if nobody edited them
	//    here; then folders left empty are removed. A list that suddenly lacks most of what was recorded looks like a
	//    fault, not like someone deleting it all: then nothing goes.
	var gone []string
	for id := range st.Files {
		if !seen[id] {
			gone = append(gone, id)
		}
	}
	var goneDirs []string
	for id := range st.Dirs {
		if !onServer[id] {
			goneDirs = append(goneDirs, id)
		}
	}
	if (len(gone) > 20 && len(gone)*2 > len(st.Files)) || (len(goneDirs) > 20 && len(goneDirs)*2 > len(st.Dirs)) {
		log.Printf("my files: %d files and %d folders are no longer on the website; not deleting so many at once", len(gone), len(goneDirs))
		s.app.setStatus(fmt.Sprintf("My files: %d files disappeared from the website; their copies are kept here.", len(gone)))
		gone, goneDirs = nil, nil
		failed = errMassChange
	}
	for _, id := range gone {
		e := st.Files[id]
		p := local(root, e.Path)
		if untouched(p, e) {
			if err := moveToTrash(p); err != nil {
				log.Printf("my files: cannot move %s to the trash: %v", e.Path, err)
				continue // tried again next round
			}
			log.Printf("my files: deleted on the website, moved to the trash: %s", e.Path)
		} else if _, err := os.Stat(p); err == nil {
			log.Printf("my files: deleted on the website, but edited here, so kept: %s", e.Path)
		}
		delete(st.Files, id)
	}
	sort.Slice(goneDirs, func(i, j int) bool { return depth(st.Dirs[goneDirs[i]]) > depth(st.Dirs[goneDirs[j]]) })
	for _, id := range goneDirs {
		p := local(root, st.Dirs[id])
		if isDir(p) && os.Remove(p) == nil { // only an empty folder: one still holding files of this person's stays
			log.Printf("my files: folder deleted on the website: %s", st.Dirs[id])
		}
		delete(st.Dirs, id)
	}
	if err := s.app.saveMirror(st); err != nil {
		return err
	}

	st.Restore = false
	// 4. What changed on this computer.
	note(s.pushLocal(api, root, &st))
	if err := s.app.saveMirror(st); err != nil {
		return err
	}
	if failed == nil {
		s.app.setStatus("")
	}
	if failed == errMassChange {
		return nil // reported in the status line; retrying every minute would not change it
	}
	return failed
}

var errMassChange = errors.New("too many files disappeared at once")

// mirrorMove moves the local copy along with a rename or move on the website; returns its new relative path.
func mirrorMove(root string, e mirrorEntry, to string) (string, error) {
	target, err := safeJoin(root, to)
	if err != nil {
		return "", err
	}
	from := local(root, e.Path)
	if _, err := os.Lstat(from); err != nil {
		rel, _ := filepath.Rel(root, target)
		return filepath.ToSlash(rel), nil // the copy is not here any more; only the record follows
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if !insideRoot(root, filepath.Dir(target)) {
		return "", errBadPath
	}
	final := target
	if !strings.EqualFold(from, target) {
		final = uniquePath(target)
	}
	if err := renameHere(from, final); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(root, final)
	return filepath.ToSlash(rel), nil
}

// mirrorSave downloads a new or changed file. An untouched copy is replaced in place; an edited one is kept as
// "name (conflict, PC).ext" and the website's version takes the name.
func (s *Syncer) mirrorSave(api *API, root string, f mirrorFile, e mirrorEntry, known bool) (mirrorEntry, error) {
	target, err := safeJoin(root, f.Path)
	if err != nil {
		return e, err
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return e, err
	}
	if !insideRoot(root, dir) {
		return e, errBadPath
	}
	res, err := api.request("GET", fmt.Sprintf("/api/agent/mirror/%d", f.ID), nil)
	if err != nil {
		return e, err
	}
	defer res.Body.Close()
	size := res.ContentLength
	if size < 0 {
		size = f.Size
	}
	v := res.Header.Get("X-Version")
	if v == "" {
		v = f.V
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".companyfiles-m%d.part", f.ID))
	os.Remove(tmp)
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return e, err
	}
	n, err := io.Copy(out, io.LimitReader(res.Body, size+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && n != size {
		err = fmt.Errorf("got %d of %d bytes", n, size)
	}
	if err != nil {
		os.Remove(tmp)
		return e, err
	}
	if f.Modified > 0 {
		t := time.UnixMilli(f.Modified)
		_ = os.Chtimes(tmp, t, t)
	}
	final := ""
	if known {
		cur := local(root, e.Path)
		if _, err := os.Lstat(cur); err == nil && !untouched(cur, e) {
			ext := filepath.Ext(cur)
			if err := os.Rename(cur, uniquePath(strings.TrimSuffix(cur, ext)+" (conflict, "+computerName()+")"+ext)); err != nil {
				os.Remove(tmp)
				return e, fmt.Errorf("open in another program, tried again later: %w", err)
			}
		}
		if err := os.Rename(tmp, cur); err != nil { // replaces an untouched copy in one step
			os.Remove(tmp)
			return e, fmt.Errorf("open in another program, tried again later: %w", err)
		}
		final = cur
	}
	if final == "" {
		if final, err = placeFile(tmp, target); err != nil {
			os.Remove(tmp)
			return e, err
		}
	}
	st, err := os.Stat(final)
	if err != nil {
		return e, err
	}
	rel, _ := filepath.Rel(root, final)
	return mirrorEntry{Path: filepath.ToSlash(rel), V: v, Size: st.Size(), MTime: st.ModTime().UnixMilli()}, nil
}

// ---- this computer → the website ----

type sighting struct {
	size, mtime int64
	at          time.Time
}

// ignoredName: files that are not documents (temporary, lock and system files) never go to the website.
func ignoredName(name string) bool {
	l := strings.ToLower(name)
	for _, suffix := range []string{".tmp", ".temp", ".part", ".crdownload", ".download", ".lnk", "~", ".companyfiles-rename"} {
		if strings.HasSuffix(l, suffix) {
			return true
		}
	}
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~$") || strings.HasPrefix(l, "~wr") ||
		l == "thumbs.db" || l == "desktop.ini" || l == "$recycle.bin" || l == "system volume information"
}

// scanLocal lists the files and folders below root ("/"-separated relative paths), skipping ignored names and links.
func scanLocal(root string) (files, dirs map[string]fs.FileInfo, err error) {
	files, dirs = map[string]fs.FileInfo{}, map[string]fs.FileInfo{}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		switch {
		case err != nil:
			if p == root {
				return err
			}
			return nil // an unreadable folder is left alone
		case p == root:
			return nil
		case ignoredName(d.Name()) || d.Type()&fs.ModeSymlink != 0:
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		case !d.IsDir() && !d.Type().IsRegular():
			return nil
		}
		if info, err := d.Info(); err == nil {
			rel, _ := filepath.Rel(root, p)
			if d.IsDir() {
				dirs[filepath.ToSlash(rel)] = info
			} else {
				files[filepath.ToSlash(rel)] = info
			}
		}
		return nil
	})
	return
}

func (s *Syncer) initLocal() {
	if s.seen == nil {
		s.seen, s.skip = map[string]sighting{}, map[string]time.Time{}
	}
}

// settled: the file has stopped changing (same size and time as at the last look 2 s ago, or untouched for 10 s),
// so a document still being written or copied is not sent half-way.
func (s *Syncer) settled(rel string, info fs.FileInfo, now time.Time) bool {
	sz, mt := info.Size(), info.ModTime().UnixMilli()
	if now.Sub(info.ModTime()) > 10*time.Second {
		delete(s.seen, rel)
		return true
	}
	prev, ok := s.seen[rel]
	if !ok || prev.size != sz || prev.mtime != mt {
		s.seen[rel] = sighting{sz, mt, now}
		return false
	}
	return now.Sub(prev.at) >= 2*time.Second
}

// twice: true once key has been noticed at two looks at least d apart (a new folder whose name is still being
// typed, or a file that a save in Word replaces for a moment, is not acted on).
func (s *Syncer) twice(key string, now time.Time, d time.Duration) bool {
	prev, ok := s.seen[key]
	if !ok {
		s.seen[key] = sighting{at: now}
		return false
	}
	return now.Sub(prev.at) >= d
}

// pushLocal sends what was added, renamed, moved, edited or deleted in this computer's copy of My files.
func (s *Syncer) pushLocal(api *API, root string, st *mirrorState) error {
	if _, err := os.Stat(root); err != nil {
		return nil
	}
	files, dirs, err := scanLocal(root)
	if err != nil {
		return nil
	}
	now := time.Now()
	waiting := func(key string) bool { t, ok := s.skip[key]; return ok && now.Before(t) }
	var failed error
	note := func(err error) {
		if err != nil && failed == nil {
			failed = err
		}
	}

	// a) Renamed or moved here: a missing folder whose files all turn up, unchanged, in a new folder (or an empty
	//    one next to a single new empty folder in the same place) is the same folder; a missing file that turns up
	//    with the same size and time elsewhere is the same file. They are renamed or moved on the website too.
	for round := 0; round < 200; round++ {
		from, to, id := s.findMovedDir(st, files, dirs)
		if id == "" {
			break
		}
		var res struct{ Path string }
		if err := api.call("POST", "/api/agent/mirror/move?"+url.Values{"dir": {"1"}, "id": {id}, "path": {to}}.Encode(), nil, &res); err != nil {
			if statusOf(err) == 401 {
				return errUnpaired
			}
			log.Printf("my files: cannot move folder %s to %s on the website: %v", from, to, err)
			s.skip["\x00movedir:"+from] = now.Add(10 * time.Minute)
			continue
		}
		st.rebase(from, to)
		log.Printf("my files: folder renamed or moved here: %s → %s", from, to)
	}
	tracked := func() (map[string]string, map[string]string) {
		fp, dp := map[string]string{}, map[string]string{}
		for id, e := range st.Files {
			fp[e.Path] = id
		}
		for id, p := range st.Dirs {
			dp[p] = id
		}
		return fp, dp
	}
	filePaths, _ := tracked()
	for id, e := range st.Files {
		if _, ok := files[e.Path]; ok {
			continue
		}
		var match string
		for rel, info := range files {
			if _, known := filePaths[rel]; !known && info.Size() == e.Size && info.ModTime().UnixMilli() == e.MTime {
				if match != "" {
					match = "" // two candidates: not sure which, so it counts as deleted and new
					break
				}
				match = rel
			}
		}
		if match == "" {
			continue
		}
		var res struct{ Path string }
		err := api.call("POST", "/api/agent/mirror/move?"+url.Values{"id": {id}, "base": {e.V}, "path": {match}}.Encode(), nil, &res)
		switch {
		case err == nil:
			log.Printf("my files: renamed or moved here: %s → %s", e.Path, match)
			e.Path = match
			st.Files[id] = e
			filePaths[match] = id
		case statusOf(err) == 401:
			return errUnpaired
		default:
			log.Printf("my files: cannot move %s on the website: %v", e.Path, err) // it counts as deleted and new
		}
	}
	filePaths, dirPaths := tracked()

	// b) New folders here (empty ones too), parents first, once their name has stood for 3 seconds.
	var newDirs []string
	for rel := range dirs {
		if _, ok := dirPaths[rel]; !ok && !waiting(rel) {
			newDirs = append(newDirs, rel)
		}
	}
	sort.Slice(newDirs, func(i, j int) bool { return depth(newDirs[i]) < depth(newDirs[j]) })
	for _, rel := range newDirs {
		if !s.twice("\x00newdir:"+rel, now, 3*time.Second) {
			continue
		}
		var res struct {
			ID   int64  `json:"id"`
			Path string `json:"path"`
		}
		err := api.call("POST", "/api/agent/mirror/dir?"+url.Values{"path": {rel}}.Encode(), nil, &res)
		switch {
		case err == nil:
			delete(s.seen, "\x00newdir:"+rel)
			st.Dirs[strconv.FormatInt(res.ID, 10)] = rel // a name the website changed is followed by the next round
			log.Printf("my files: new folder here, made on the website: %s", rel)
		case statusOf(err) == 401:
			return errUnpaired
		default:
			log.Printf("my files: the website did not take folder %s: %v", rel, err)
			s.skip[rel] = now.Add(10 * time.Minute)
			note(fmt.Errorf("%s: %w", rel, err))
		}
	}

	// c) New and edited files.
	for rel, info := range files {
		delete(s.seen, "\x00gone:"+rel)
		if waiting(rel) {
			continue
		}
		id, known := filePaths[rel]
		e := st.Files[id]
		if known && untouched(local(root, rel), e) {
			delete(s.seen, rel)
			continue
		}
		if !s.settled(rel, info, now) {
			continue
		}
		s.app.setStatus("My files: sending " + filepath.Base(rel) + " to the website")
		nid, ne, err := s.upload(api, root, rel, id, e)
		switch {
		case err == nil:
			if known && nid != id {
				delete(st.Files, id)
			}
			st.Files[nid] = ne
			delete(s.skip, rel)
			log.Printf("my files: sent %s to the website", rel)
		case statusOf(err) == 401:
			return errUnpaired
		case statusOf(err) == 409 && known:
			// changed on the website meanwhile: the next round keeps both (the edit as a conflict copy)
		case statusOf(err) >= 400 && statusOf(err) < 500:
			log.Printf("my files: the website did not take %s: %v", rel, err)
			s.skip[rel] = now.Add(10 * time.Minute)
			note(fmt.Errorf("%s: %s", rel, err.(*httpError).Msg))
		default:
			s.skip[rel] = now.Add(time.Minute)
			note(fmt.Errorf("%s: %w", rel, err))
		}
	}

	// d) Deleted here: files, then folders (deepest first) go to the website's trash, once missing at two looks
	//    2 seconds apart. A mass disappearance deletes nothing.
	var missing, missingDirs []string
	for id, e := range st.Files {
		if _, ok := files[e.Path]; !ok && !waiting("\x00gone:"+e.Path) {
			missing = append(missing, id)
		}
	}
	for id, p := range st.Dirs {
		if _, ok := dirs[p]; !ok && !waiting("\x00gone:"+p) {
			missingDirs = append(missingDirs, id)
		}
	}
	if (len(missing) > 20 && len(missing)*2 > len(st.Files)) || (len(missingDirs) > 20 && len(missingDirs)*2 > len(st.Dirs)) {
		log.Printf("my files: %d files and %d folders are missing here; not deleting so many on the website", len(missing), len(missingDirs))
		for _, id := range missing {
			s.skip["\x00gone:"+st.Files[id].Path] = now.Add(10 * time.Minute)
		}
		for _, id := range missingDirs {
			s.skip["\x00gone:"+st.Dirs[id]] = now.Add(10 * time.Minute)
		}
		st.Restore = true // the next round brings them back from the website
		return fmt.Errorf("%d files disappeared from this computer at once; they stay on the website and come back here", len(missing)+len(missingDirs))
	}
	for _, id := range missing {
		e := st.Files[id]
		if !s.twice("\x00gone:"+e.Path, now, 2*time.Second) {
			continue
		}
		delete(s.seen, "\x00gone:"+e.Path)
		err := api.call("DELETE", fmt.Sprintf("/api/agent/mirror/%s?base=%s", id, url.QueryEscape(e.V)), nil, nil)
		switch {
		case err == nil || statusOf(err) == 404:
			delete(st.Files, id)
			log.Printf("my files: deleted here, moved to the website's trash: %s", e.Path)
		case statusOf(err) == 409:
			delete(st.Files, id) // changed on the website meanwhile: the next round downloads it again
		case statusOf(err) == 401:
			return errUnpaired
		default:
			note(fmt.Errorf("%s: %w", e.Path, err))
		}
	}
	sort.Slice(missingDirs, func(i, j int) bool { return depth(st.Dirs[missingDirs[i]]) > depth(st.Dirs[missingDirs[j]]) })
	for _, id := range missingDirs {
		p := st.Dirs[id]
		if !s.twice("\x00gone:"+p, now, 2*time.Second) {
			continue
		}
		delete(s.seen, "\x00gone:"+p)
		err := api.call("DELETE", "/api/agent/mirror/dir/"+id, nil, nil)
		switch {
		case err == nil || statusOf(err) == 404:
			delete(st.Dirs, id)
			log.Printf("my files: folder deleted here, moved to the website's trash: %s", p)
		case statusOf(err) == 409:
			// Something in it on the website that this computer has not deleted (added there meanwhile): the folder
			// comes back here, and what is in it with it.
			if err := os.MkdirAll(local(root, p), 0o755); err != nil {
				delete(st.Dirs, id)
			}
		case statusOf(err) == 401:
			return errUnpaired
		default:
			note(fmt.Errorf("%s: %w", p, err))
		}
	}
	return failed
}

// findMovedDir: a recorded folder missing here that reappeared under another name or place.
func (s *Syncer) findMovedDir(st *mirrorState, files, dirs map[string]fs.FileInfo) (from, to, id string) {
	known := map[string]bool{}
	for _, p := range st.Dirs {
		known[p] = true
	}
	var missing []string
	for did, p := range st.Dirs {
		if _, ok := dirs[p]; !ok && !s.waitingKey("\x00movedir:"+p) {
			missing = append(missing, did)
		}
	}
	sort.Slice(missing, func(i, j int) bool { return depth(st.Dirs[missing[i]]) < depth(st.Dirs[missing[j]]) })
	for _, did := range missing {
		p0 := st.Dirs[did]
		var inside []mirrorEntry
		for _, e := range st.Files {
			if strings.HasPrefix(e.Path, p0+"/") {
				inside = append(inside, e)
			}
		}
		match, count := "", 0
		for cand := range dirs {
			if known[cand] {
				continue
			}
			if len(inside) > 0 {
				same := true
				for _, e := range inside {
					info, ok := files[cand+e.Path[len(p0):]]
					if !ok || info.Size() != e.Size || info.ModTime().UnixMilli() != e.MTime {
						same = false
						break
					}
				}
				if same {
					match, count = cand, count+1
				}
				continue
			}
			// an empty folder: renamed in place if exactly one new empty folder appeared next to it
			if parentOf(cand) == parentOf(p0) && !hasEntries(cand, files, dirs) {
				match, count = cand, count+1
			}
		}
		if count == 1 {
			return p0, match, did
		}
	}
	return "", "", ""
}

func hasEntries(dir string, files, dirs map[string]fs.FileInfo) bool {
	for p := range files {
		if strings.HasPrefix(p, dir+"/") {
			return true
		}
	}
	for p := range dirs {
		if strings.HasPrefix(p, dir+"/") {
			return true
		}
	}
	return false
}

func (s *Syncer) waitingKey(key string) bool {
	t, ok := s.skip[key]
	return ok && time.Now().Before(t)
}

func (s *Syncer) upload(api *API, root, rel, id string, e mirrorEntry) (string, mirrorEntry, error) {
	f, err := os.Open(local(root, rel))
	if err != nil {
		return "", e, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", e, err
	}
	q := url.Values{}
	if id != "" {
		q.Set("id", id)
		q.Set("base", e.V)
	} else {
		q.Set("path", rel)
	}
	var res struct {
		ID int64  `json:"id"`
		V  string `json:"v"`
	}
	if err := api.upload("PUT", "/api/agent/mirror/file?"+q.Encode(), f, info.Size(), &res); err != nil {
		return "", e, err
	}
	// Recorded as it was when read: if it changed during the upload, the next look sends it again. A name the
	// website changed (characters it does not allow) is followed by the next round, which renames the copy.
	return strconv.FormatInt(res.ID, 10), mirrorEntry{Path: rel, V: res.V, Size: info.Size(), MTime: info.ModTime().UnixMilli()}, nil
}

// watchLocal looks at the copy of My files every 3 seconds and starts a round when something changed there.
func (s *Syncer) watchLocal(ctx context.Context) {
	t := time.NewTicker(3 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if s.localChanged() {
			s.pokeMirror()
		}
	}
}

func (s *Syncer) localChanged() bool {
	if !s.mbusy.TryLock() {
		return false // a round is running and looks itself
	}
	defer s.mbusy.Unlock()
	s.initLocal()
	cfg := s.app.config()
	root := filepath.Join(cfg.folder(), mirrorDir)
	st := s.app.loadMirror(root, cfg.Server+" "+cfg.User)
	if _, err := os.Stat(root); err != nil {
		return len(st.Files)+len(st.Dirs) > 0 // vanished: a round brings it back
	}
	files, dirs, err := scanLocal(root)
	if err != nil {
		return false
	}
	now := time.Now()
	waiting := func(key string) bool { t, ok := s.skip[key]; return ok && now.Before(t) }
	trackedFiles, trackedDirs := map[string]bool{}, map[string]bool{}
	for _, e := range st.Files {
		trackedFiles[e.Path] = true
		info, ok := files[e.Path]
		if !ok && !waiting("\x00gone:"+e.Path) || ok && (info.Size() != e.Size || info.ModTime().UnixMilli() != e.MTime) && !waiting(e.Path) {
			return true
		}
	}
	for _, p := range st.Dirs {
		trackedDirs[p] = true
		if _, ok := dirs[p]; !ok && !waiting("\x00gone:"+p) {
			return true
		}
	}
	for rel := range files {
		if !trackedFiles[rel] && !waiting(rel) {
			return true
		}
	}
	for rel := range dirs {
		if !trackedDirs[rel] && !waiting(rel) {
			return true
		}
	}
	return false
}
