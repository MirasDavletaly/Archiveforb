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
	"strconv"
	"strings"
	"time"
)

// The person's "My files" on the website are kept copied into <folder>/My files while the agent runs (decided
// 2026-11-19): files added or changed after this computer was connected are downloaded, renamed and moved ones
// follow, deleted ones go to the computer's trash. A copy the person edited here is never replaced or deleted:
// the website's new version is saved next to it instead. The server only says "My files changed"; the agent
// compares the list with what it saved (mirror.json), so it also catches up after being off.
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
}

type mirrorFile struct {
	ID       int64  `json:"id"`
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	V        string `json:"v"`
	Modified int64  `json:"modified"`
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

// untouched: the copy is still exactly as the agent saved it.
func untouched(p string, e mirrorEntry) bool {
	st, err := os.Stat(p)
	return err == nil && st.Mode().IsRegular() && st.Size() == e.Size && st.ModTime().UnixMilli() == e.MTime
}

func local(root, rel string) string { return filepath.Join(root, filepath.FromSlash(rel)) }

// mirror brings <folder>/My files up to date once.
func (s *Syncer) mirror(ctx context.Context) error {
	s.mbusy.Lock()
	defer s.mbusy.Unlock()
	cfg := s.app.config()
	api := newAPI(cfg.Server, cfg.Token)
	var list struct {
		Since int64        `json:"since"`
		Files []mirrorFile `json:"files"`
	}
	if err := api.call("GET", "/api/agent/mirror", nil, &list); err != nil {
		if statusOf(err) == 401 {
			return errUnpaired
		}
		return err
	}
	root := filepath.Join(cfg.folder(), mirrorDir)
	st := s.app.loadMirror(root, cfg.Server+" "+cfg.User)
	seen := map[string]bool{}
	var failed error
	todo := 0
	for _, f := range list.Files {
		if _, ok := st.Files[strconv.FormatInt(f.ID, 10)]; ok || f.Modified > list.Since {
			todo++
		}
	}
	done := 0
	for _, f := range list.Files {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		id := strconv.FormatInt(f.ID, 10)
		seen[id] = true
		e, known := st.Files[id]
		if !known && f.Modified <= list.Since {
			continue // was there before this computer was connected: not copied (it can be sent with Enter)
		}
		if known && e.Path != f.Path { // renamed or moved on the website
			if moved, err := mirrorMove(root, e, f.Path); err == nil {
				e.Path = moved
				st.Files[id] = e
			} else {
				log.Printf("my files: cannot move %s to %s: %v", e.Path, f.Path, err)
			}
		}
		if known && e.V == f.V {
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
			if failed == nil {
				failed = fmt.Errorf("%s: %w", f.Path, err)
			}
		}
		if done%20 == 0 {
			_ = s.app.saveMirror(st) // progress survives a crash or a shutdown
		}
	}
	// Deleted on the website (or no longer in My files): the copy goes to this computer's trash, if nobody edited it
	// here. A list that suddenly lacks most files looks like a fault, not like someone deleting them: then nothing goes.
	var gone []string
	for id := range st.Files {
		if !seen[id] {
			gone = append(gone, id)
		}
	}
	if len(gone) > 20 && len(gone)*2 > len(st.Files) {
		log.Printf("my files: %d of %d copies are no longer on the website; not deleting so many at once", len(gone), len(st.Files))
		s.app.setStatus(fmt.Sprintf("My files: %d files disappeared from the website; their copies are kept here.", len(gone)))
		gone = nil
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
			removeEmptyDirs(root, filepath.Dir(p))
		} else if _, err := os.Stat(p); err == nil {
			log.Printf("my files: deleted on the website, but edited here, so kept: %s", e.Path)
		}
		delete(st.Files, id)
	}
	if err := s.app.saveMirror(st); err != nil {
		return err
	}
	if err := s.pushLocal(api, root, &st); err != nil && failed == nil {
		failed = err
	}
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
	final := uniquePath(target)
	if err := os.Rename(from, final); err != nil {
		return "", err
	}
	removeEmptyDirs(root, filepath.Dir(from))
	rel, _ := filepath.Rel(root, final)
	return filepath.ToSlash(rel), nil
}

// mirrorSave downloads a new or changed file. An untouched copy is replaced in place; an edited one stays and the
// website's version is saved next to it ("report (1).docx"), becoming the tracked copy.
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
			// Edited here and changed on the website: the edit is kept as "name (conflict, Computer).ext" (uploaded
			// as such next), and the website's version takes the name.
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
	for _, suffix := range []string{".tmp", ".temp", ".part", ".crdownload", ".download", ".lnk", "~"} {
		if strings.HasSuffix(l, suffix) {
			return true
		}
	}
	return strings.HasPrefix(name, ".") || strings.HasPrefix(name, "~$") || strings.HasPrefix(l, "~wr") ||
		l == "thumbs.db" || l == "desktop.ini" || l == "$recycle.bin" || l == "system volume information"
}

// scanLocal lists the regular files below root ("/"-separated relative paths), skipping ignored names and links.
func scanLocal(root string) (map[string]fs.FileInfo, error) {
	out := map[string]fs.FileInfo{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
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
		case !d.Type().IsRegular():
			return nil
		}
		if info, err := d.Info(); err == nil {
			rel, _ := filepath.Rel(root, p)
			out[filepath.ToSlash(rel)] = info
		}
		return nil
	})
	return out, err
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

// pushLocal sends what was added, edited or deleted in this computer's copy of My files to the website.
func (s *Syncer) pushLocal(api *API, root string, st *mirrorState) error {
	s.initLocal()
	if _, err := os.Stat(root); err != nil {
		return nil // the folder is not there (an unplugged drive, deleted by hand): that is not a deletion of every file
	}
	files, err := scanLocal(root)
	if err != nil {
		return nil
	}
	byPath := map[string]string{}
	for id, e := range st.Files {
		byPath[e.Path] = id
	}
	now := time.Now()
	var failed error
	for rel, info := range files {
		delete(s.seen, "\x00gone:"+rel)
		if t, ok := s.skip[rel]; ok && now.Before(t) {
			continue
		}
		id, tracked := byPath[rel]
		e := st.Files[id]
		if tracked && untouched(local(root, rel), e) {
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
			if tracked && nid != id {
				delete(st.Files, id)
			}
			st.Files[nid] = ne
			delete(s.skip, rel)
			log.Printf("my files: sent %s to the website", rel)
		case statusOf(err) == 401:
			return errUnpaired
		case statusOf(err) == 409 && tracked:
			// changed on the website meanwhile: the next round keeps both (the edit as a conflict copy)
		case statusOf(err) >= 400 && statusOf(err) < 500:
			log.Printf("my files: the website did not take %s: %v", rel, err)
			s.skip[rel] = now.Add(10 * time.Minute)
			if failed == nil {
				failed = fmt.Errorf("%s: %s", rel, err.(*httpError).Msg)
			}
		default:
			s.skip[rel] = now.Add(time.Minute)
			if failed == nil {
				failed = fmt.Errorf("%s: %w", rel, err)
			}
		}
	}
	// Deleted here: to the website's trash (restorable there for 30 days). A file must be missing at two looks 2 s
	// apart (a save in Word replaces the file for a moment), and a mass disappearance deletes nothing.
	var missing []string
	for id, e := range st.Files {
		if _, ok := files[e.Path]; !ok {
			missing = append(missing, id)
		}
	}
	if len(missing) > 20 && len(missing)*2 > len(st.Files) {
		log.Printf("my files: %d of %d files are missing here; not deleting so many on the website", len(missing), len(st.Files))
		for _, id := range missing {
			s.skip["\x00gone:"+st.Files[id].Path] = now.Add(10 * time.Minute)
		}
		return fmt.Errorf("%d files disappeared from this computer at once; they stay on the website", len(missing))
	}
	for _, id := range missing {
		e := st.Files[id]
		key := "\x00gone:" + e.Path
		if t, ok := s.skip[key]; ok && now.Before(t) {
			continue
		}
		if prev, ok := s.seen[key]; !ok || now.Sub(prev.at) < 2*time.Second {
			if !ok {
				s.seen[key] = sighting{at: now}
			}
			continue
		}
		delete(s.seen, key)
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
			if failed == nil {
				failed = fmt.Errorf("%s: %w", e.Path, err)
			}
		}
	}
	return failed
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
	if _, err := os.Stat(root); err != nil {
		return false
	}
	files, err := scanLocal(root)
	if err != nil {
		return false
	}
	st := s.app.loadMirror(root, cfg.Server+" "+cfg.User)
	now := time.Now()
	waiting := func(key string) bool { t, ok := s.skip[key]; return ok && now.Before(t) }
	tracked := map[string]bool{}
	for _, e := range st.Files {
		tracked[e.Path] = true
		info, ok := files[e.Path]
		if !ok && !waiting("\x00gone:"+e.Path) || ok && (info.Size() != e.Size || info.ModTime().UnixMilli() != e.MTime) && !waiting(e.Path) {
			return true
		}
	}
	for rel := range files {
		if !tracked[rel] && !waiting(rel) {
			return true
		}
	}
	return false
}

// removeEmptyDirs deletes folders left empty by a move or deletion, up to (not including) root.
func removeEmptyDirs(root, dir string) {
	for dir != root && strings.HasPrefix(dir, root+string(filepath.Separator)) {
		if os.Remove(dir) != nil { // fails when not empty
			return
		}
		dir = filepath.Dir(dir)
	}
}
