package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

var errUnpaired = errors.New("this computer is no longer connected")

// Syncer keeps a WebSocket open to the server, which only says "your queue changed"; the files themselves come
// over HTTPS. On every (re)connect the whole queue is checked, so files sent while the computer was off arrive.
type Syncer struct {
	app    *App
	kick   chan struct{}
	cancel context.CancelFunc
	busy   sync.Mutex
}

func startSyncer(a *App) *Syncer {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Syncer{app: a, kick: make(chan struct{}, 1), cancel: cancel}
	go s.socket(ctx)
	go s.worker(ctx)
	return s
}

func (s *Syncer) stop() { s.cancel() }

func (s *Syncer) poke() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *Syncer) socket(ctx context.Context) {
	wait := 2 * time.Second
	for ctx.Err() == nil {
		cfg := s.app.config()
		u := strings.Replace(strings.Replace(cfg.Server, "https://", "wss://", 1), "http://", "ws://", 1) + "/api/agent/ws"
		dctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		conn, res, err := websocket.Dial(dctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.Token}, "User-Agent": {userAgent()}}})
		cancel()
		if err != nil {
			if res != nil && res.StatusCode == http.StatusUnauthorized {
				s.app.unpaired()
				return
			}
			s.app.setStatus("Offline: cannot reach the server, retrying…")
			log.Printf("websocket: %v", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			if wait < time.Minute {
				wait *= 2
			}
			continue
		}
		wait = 2 * time.Second
		s.app.setStatus("")
		conn.SetReadLimit(64 << 10)
		for {
			_, _, err := conn.Read(ctx) // control frames (the server's pings) are answered inside Read
			if err != nil {
				break
			}
			s.poke()
		}
		conn.CloseNow()
		if ctx.Err() == nil {
			s.app.setStatus("Offline: connection lost, retrying…")
		}
	}
}

// worker processes the queue when poked, and every 10 minutes in case a notice was missed.
func (s *Syncer) worker(ctx context.Context) {
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		case <-tick.C:
		}
		err := s.run(ctx)
		switch {
		case errors.Is(err, errUnpaired):
			s.app.unpaired()
			return
		case statusOf(err) == http.StatusTooManyRequests:
			s.app.setStatus("Paused: the hourly download limit is reached. Continuing later.")
			select {
			case <-ctx.Done():
				return
			case <-time.After(15 * time.Minute):
				s.poke()
			}
		case err != nil && ctx.Err() == nil:
			log.Printf("queue: %v", err)
			s.app.setStatus("Some files could not be saved yet. Retrying…")
			time.AfterFunc(time.Minute, s.poke)
		}
	}
}

// run saves everything in the queue once. Returns the first error that stops the round.
func (s *Syncer) run(ctx context.Context) error {
	s.busy.Lock()
	defer s.busy.Unlock()
	cfg := s.app.config()
	api := newAPI(cfg.Server, cfg.Token)
	var items []QueueItem
	if err := api.call("GET", "/api/agent/queue", nil, &items); err != nil {
		if statusOf(err) == http.StatusUnauthorized {
			return errUnpaired
		}
		return err
	}
	if len(items) == 0 {
		s.app.setStatus("")
		return nil
	}
	root := cfg.folder()
	if err := os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	var failed error
	for i, it := range items {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.app.setStatus(fmt.Sprintf("Saving %d of %d: %s", i+1, len(items), filepath.Base(it.Path)))
		where, err := s.save(api, root, it)
		switch {
		case err == nil:
			log.Printf("saved %s", where)
			s.app.saved(where)
		case errors.Is(err, errBadPath):
			log.Printf("refused unsafe path %q", it.Path)
			_ = api.call("POST", fmt.Sprintf("/api/agent/files/%d/done", it.ID), map[string]string{"result": "skipped"}, nil)
		case statusOf(err) == http.StatusNotFound:
			// no longer available (deleted, or access taken away): the server already dropped it
		case statusOf(err) == http.StatusUnauthorized:
			return errUnpaired
		case statusOf(err) == http.StatusTooManyRequests:
			return err
		default:
			if failed == nil {
				failed = fmt.Errorf("%s: %w", it.Path, err)
			}
		}
	}
	if failed == nil {
		s.app.setStatus("")
	}
	return failed
}

// save downloads one file next to its destination, then gives it its name without overwriting anything.
func (s *Syncer) save(api *API, root string, it QueueItem) (string, error) {
	target, err := safeJoin(root, it.Path)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if !insideRoot(root, dir) {
		return "", errBadPath
	}
	res, err := api.request("GET", fmt.Sprintf("/api/agent/files/%d", it.ID), nil)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	tmp := filepath.Join(dir, fmt.Sprintf(".companyfiles-%d.part", it.ID))
	os.Remove(tmp) // a leftover from an interrupted save, or something planted there: never written through
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, io.LimitReader(res.Body, it.Size+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil && n != it.Size {
		err = fmt.Errorf("got %d of %d bytes", n, it.Size)
	}
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	if it.Modified > 0 {
		t := time.UnixMilli(it.Modified)
		_ = os.Chtimes(tmp, t, t)
	}
	final, err := placeFile(tmp, target)
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := api.call("POST", fmt.Sprintf("/api/agent/files/%d/done", it.ID), map[string]string{"result": "saved"}, nil); err != nil {
		log.Printf("could not report %s as saved (it may be saved again later): %v", it.Path, err)
	}
	return final, nil
}
