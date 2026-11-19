//go:build darwin

package main

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
// Implemented in urlevents_darwin.m (Objective-C).
void cfRegisterURLHandler(void);
void cfRunHidden(void);
int cfTrash(const char *path);
*/
import "C"

import (
	"fmt"
	"sync"
	"unsafe"
)

func moveToTrash(p string) error {
	cs := C.CString(p)
	defer C.free(unsafe.Pointer(cs))
	if code := C.cfTrash(cs); code != 0 {
		return fmt.Errorf("not moved to the Trash (error %d)", int(code))
	}
	return nil
}

var (
	urlMu      sync.Mutex
	urlHandler func(string)
	urlPending []string
)

//export goHandleURL
func goHandleURL(u *C.char) {
	s := C.GoString(u)
	urlMu.Lock()
	h := urlHandler
	if h == nil {
		urlPending = append(urlPending, s)
	}
	urlMu.Unlock()
	if h != nil {
		h(s)
	}
}

// runHidden must run on the main thread, like the tray (the systray package locks main there in its init).
func runHidden(a *App) {
	registerURLEvents(func(link string) { go a.handleLink(link) })
	C.cfRunHidden()
}

func registerURLEvents(h func(string)) {
	C.cfRegisterURLHandler()
	urlMu.Lock()
	urlHandler = h
	pending := urlPending
	urlPending = nil
	urlMu.Unlock()
	for _, s := range pending {
		h(s)
	}
}
