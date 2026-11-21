//go:build darwin

package main

// Files on demand on a Mac, as OneDrive does it (decided 2026-11-20, once the app could be signed with a Developer
// ID): Apple's File Provider. The extension inside the app (agent/fileprovider/*.swift) lists the website's tree,
// downloads a file when it is opened and sends what is made or changed here; Finder shows it on the left, under
// Locations, with cloud icons. This side adds the domain, hands the extension the server address and this
// computer's token (in the folder they share), and tells it when the website changed. Without a signature the app
// has no extension and uses the network drive instead.

/*
#cgo LDFLAGS: -framework FileProvider -framework Foundation
#include <stdlib.h>
int cfFPAdd(const char *ident, const char *name, char *err, int errlen);
int cfFPRemove(const char *ident, const char *name, char *err, int errlen);
int cfFPSignal(const char *ident, const char *name);
int cfFPRoot(const char *ident, const char *name, char *out, int outlen);
int cfGroupPath(const char *group, char *out, int outlen);
*/
import "C"

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"time"
	"unsafe"
)

// appGroup is set when the app is built signed ("<team id>.com.companyfiles"); the extension has the same.
var appGroup string

const fpDomain = "CompanyFiles"

func fpSupported() bool {
	if appGroup == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(filepath.Dir(exePath()), "..", "PlugIns", "CompanyFilesProvider.appex"))
	return err == nil
}

func cstr(s string) *C.char { return C.CString(s) }

func fpCall(f func(id, name *C.char, buf *C.char, n C.int) C.int, cfg Config) (string, error) {
	id, name := cstr(fpDomain), cstr(cfg.name())
	defer C.free(unsafe.Pointer(id))
	defer C.free(unsafe.Pointer(name))
	buf := make([]byte, 2048)
	if f(id, name, (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf))) != 0 {
		return "", errors.New(C.GoString((*C.char)(unsafe.Pointer(&buf[0]))))
	}
	return C.GoString((*C.char)(unsafe.Pointer(&buf[0]))), nil
}

func groupDir() (string, error) {
	g := cstr(appGroup)
	defer C.free(unsafe.Pointer(g))
	buf := make([]byte, 2048)
	if C.cfGroupPath(g, (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf))) != 0 {
		return "", errors.New("no shared folder for " + appGroup)
	}
	return C.GoString((*C.char)(unsafe.Pointer(&buf[0]))), nil
}

// fpShare writes what the extension needs to reach the website (token "" when this computer is disconnected).
func fpShare(cfg Config, token string) error {
	dir, err := groupDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]string{"server": cfg.Server, "token": token})
	tmp := filepath.Join(dir, "provider.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, "provider.json")); err != nil {
		return err
	}
	log.Printf("files on demand: the extension's settings are in %s", dir)
	return nil
}

func fpSignal(cfg Config) {
	id, name := cstr(fpDomain), cstr(cfg.name())
	defer C.free(unsafe.Pointer(id))
	defer C.free(unsafe.Pointer(name))
	C.cfFPSignal(id, name)
}

// runFileProvider keeps the provider going while this computer is paired. If it does not come up (the extension
// never reaches the website within a few minutes), this Mac uses the network drive instead, so the files are always
// there; the next version of the app tries the provider again.
func (s *Syncer) runFileProvider(stop <-chan struct{}) {
	cfg := s.app.config()
	start := time.Now()
	fallback := func(why string) {
		log.Printf("files on demand: %s; using the network drive instead", why)
		fpTeardown(cfg)
		_ = s.app.update(func(c *Config) { c.FPFailed = version })
		s.runDrive(stop)
	}
	// The extension is registered and switched on for this user (as Finder's settings would), in case macOS has not
	// done it yet for a freshly installed app.
	appex := filepath.Join(filepath.Dir(exePath()), "..", "PlugIns", "CompanyFilesProvider.appex")
	_ = exec.Command("pluginkit", "-a", appex).Run()
	_ = exec.Command("pluginkit", "-e", "use", "-i", "com.companyfiles.agent.provider").Run()
	if err := fpShare(cfg, cfg.Token); err != nil {
		fallback(err.Error())
		return
	}
	if _, err := fpCall(func(id, name, buf *C.char, n C.int) C.int { return C.cfFPAdd(id, name, buf, n) }, cfg); err != nil {
		fallback("the system did not add it: " + err.Error())
		return
	}
	root, _ := fpCall(func(id, name, buf *C.char, n C.int) C.int { return C.cfFPRoot(id, name, buf, n) }, cfg)
	fpSignal(cfg)
	if !fpWorking(start, root, stop) {
		select {
		case <-stop:
			return
		default:
		}
		fallback("the Finder extension did not reach the website in 5 minutes")
		return
	}
	driveTeardown(cfg) // a Mac that had the network drive before: the provider replaces it
	log.Printf("files on demand: %s is in Finder (%s)", cfg.name(), root)
	s.app.setStatus("")
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-stop:
			return
		case <-tick.C:
			fpSignal(cfg)
		case <-s.cloudKick: // the website says something changed
			fpSignal(cfg)
		}
	}
}

// fpWorking waits up to 5 minutes for the extension's "provider-ok" mark (written when it reaches the website),
// looking into Finder's folder meanwhile so the system starts the extension.
func fpWorking(start time.Time, root string, stop <-chan struct{}) bool {
	dir, err := groupDir()
	if err != nil {
		return false
	}
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		if st, err := os.Stat(filepath.Join(dir, "provider-ok")); err == nil && st.ModTime().After(start.Add(-time.Second)) {
			return true
		}
		if root != "" {
			_, _ = os.ReadDir(root)
		}
		select {
		case <-stop:
			return false
		case <-time.After(5 * time.Second):
		}
	}
	return false
}

// fpOpen shows the provider's folder in Finder.
func fpOpen(a *App) {
	cfg := a.config()
	root, err := fpCall(func(id, name, buf *C.char, n C.int) C.int { return C.cfFPRoot(id, name, buf, n) }, cfg)
	if err != nil || root == "" {
		message(cfg.name(), cfg.name()+" is not ready in Finder yet. Try again in a minute.")
		return
	}
	openPath(root)
}

// fpTeardown removes the provider (this computer was disconnected, or the program removed); the token is forgotten.
func fpTeardown(cfg Config) {
	if !fpSupported() {
		return
	}
	_ = fpShare(cfg, "")
	if _, err := fpCall(func(id, name, buf *C.char, n C.int) C.int { return C.cfFPRemove(id, name, buf, n) }, cfg); err != nil {
		log.Printf("files on demand: removing: %v", err)
	}
}
