//go:build darwin

package main

// The network drive (decided 2026-11-20): on a Mac, OneDrive-style files on demand needs Apple's File Provider, which
// runs only in apps signed with a paid Apple Developer ID. Instead the agent mounts the website as a WebDAV drive:
// Finder shows it under Locations in the sidebar (and it is pinned to Favorites once), every folder the person can
// open is there, and a file is downloaded when it is opened. The password is this computer's token.

/*
#cgo LDFLAGS: -framework NetFS -framework CoreFoundation
#include <NetFS/NetFS.h>
#include <stdlib.h>
#include <string.h>

// The same mount Finder makes, with no dialogs: whatever would need one (a password, a certificate question) comes
// back as an error code instead of a window nobody may be there to answer.
static int cf_mount(const char *url, const char *user, const char *pass, char *out, int outlen) {
	CFURLRef u = CFURLCreateWithBytes(NULL, (const UInt8 *)url, (CFIndex)strlen(url), kCFStringEncodingUTF8, NULL);
	if (!u) return -1;
	CFStringRef cu = CFStringCreateWithCString(NULL, user, kCFStringEncodingUTF8);
	CFStringRef cp = CFStringCreateWithCString(NULL, pass, kCFStringEncodingUTF8);
	CFMutableDictionaryRef open = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFDictionarySetValue(open, kNAUIOptionKey, kNAUIOptionNoUI);
	CFArrayRef points = NULL;
	int r = NetFSMountURLSync(u, NULL, cu, cp, open, NULL, &points);
	out[0] = 0;
	if (r == 0 && points && CFArrayGetCount(points) > 0) {
		CFStringRef p = (CFStringRef)CFArrayGetValueAtIndex(points, 0);
		if (!CFStringGetCString(p, out, outlen, kCFStringEncodingUTF8)) out[0] = 0;
	}
	if (points) CFRelease(points);
	CFRelease(open);
	CFRelease(cp);
	CFRelease(cu);
	CFRelease(u);
	return r;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os/exec"
	"strings"
	"time"
	"unsafe"
)

const driveSupported = true

func driveURL(cfg Config) string {
	return strings.TrimRight(cfg.Server, "/") + "/dav/" + url.PathEscape(cfg.name())
}

// driveMountPoint: where the drive is mounted now ("" when it is not).
func driveMountPoint(cfg Config) string {
	out, _ := exec.Command("mount").Output()
	u, err := url.Parse(cfg.Server)
	if err != nil {
		return ""
	}
	want := u.Host + "/dav/" + url.PathEscape(cfg.name())
	for _, l := range strings.Split(string(out), "\n") {
		i := strings.Index(l, " on ")
		if i < 0 || !strings.Contains(l[:i], want) || !strings.Contains(l, "(webdav") {
			continue
		}
		if rest := l[i+4:]; strings.LastIndex(rest, " (") > 0 {
			return rest[:strings.LastIndex(rest, " (")]
		}
	}
	return ""
}

// mountDrive connects the drive the way Finder does (NetFS, mounted under /Volumes), without any dialog. The token
// is handed over in memory, never on a command line.
func mountDrive(cfg Config) error {
	cu, cn, cp := C.CString(driveURL(cfg)), C.CString("computer"), C.CString(cfg.Token)
	done := make(chan error, 1)
	go func() { // freed here, not on return: after a timeout the call may still be using them
		defer C.free(unsafe.Pointer(cu))
		defer C.free(unsafe.Pointer(cn))
		defer C.free(unsafe.Pointer(cp))
		buf := make([]byte, 1024)
		if r := C.cf_mount(cu, cn, cp, (*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf))); r != 0 {
			done <- fmt.Errorf("the system could not connect it (NetFS code %d)", int(r))
			return
		}
		done <- nil
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Minute):
		return errors.New("no answer from the server in 2 minutes")
	}
}

// runDrive keeps the drive connected while this computer is paired: at start, then every 10 minutes (every minute
// while it cannot connect, for example offline).
func (s *Syncer) runDrive(stop <-chan struct{}) {
	wait := time.Duration(0)
	for {
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
		cfg := s.app.config()
		if cfg.Token == "" {
			return
		}
		if driveMountPoint(cfg) == "" {
			if err := mountDrive(cfg); err != nil {
				log.Printf("network drive: %v", err)
				s.app.setStatus("The " + cfg.name() + " drive is not connected yet. Retrying…")
				wait = time.Minute
				continue
			}
			mp := driveMountPoint(cfg)
			log.Printf("network drive: connected at %s", mp)
			s.app.setStatus("")
			if mp != "" && !cfg.DrivePinned {
				pinToSidebar(mp)
				_ = s.app.update(func(c *Config) { c.DrivePinned = true })
			}
		}
		wait = 10 * time.Minute
	}
}

// pinToSidebar adds the drive to Finder's Favorites, once (someone who removes it keeps it removed). sfltool is
// Apple's own tool for the sidebar lists; where it cannot do it, the drive still shows under Locations.
func pinToSidebar(mp string) {
	u := (&url.URL{Scheme: "file", Path: mp + "/"}).String()
	if out, err := exec.Command("sfltool", "add-item", "com.apple.LSSharedFileList.FavoriteItems", u).CombinedOutput(); err != nil {
		log.Printf("network drive: not pinned to Favorites (%v %s); it shows under Locations", err, strings.TrimSpace(string(out)))
	}
}

// driveOpen opens the drive in Finder, connecting it first when needed.
func driveOpen(a *App) {
	cfg := a.config()
	mp := driveMountPoint(cfg)
	if mp == "" {
		if err := mountDrive(cfg); err != nil {
			message(cfg.name(), "The "+cfg.name()+" drive could not be connected: "+err.Error())
			return
		}
		mp = driveMountPoint(cfg)
	}
	openPath(mp)
}

// driveTeardown disconnects the drive (this computer was disconnected, or the program removed).
func driveTeardown(cfg Config) {
	if mp := driveMountPoint(cfg); mp != "" {
		if err := exec.Command("umount", mp).Run(); err != nil {
			_ = exec.Command("diskutil", "unmount", "force", mp).Run()
		}
	}
}
