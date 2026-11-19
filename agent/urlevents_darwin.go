//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa
#import <Cocoa/Cocoa.h>

extern void goHandleURL(char *url);

// macOS hands myfiles:// links to an app as "get URL" Apple events, not as program arguments.
@interface CFURLHandler : NSObject
- (void)handle:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply;
@end

@implementation CFURLHandler
- (void)handle:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply {
	NSString *s = [[event paramDescriptorForKeyword:keyDirectObject] stringValue];
	if (s != nil) goHandleURL((char *)[s UTF8String]);
}
@end

static CFURLHandler *cfHandler;

static void cfRegisterURLHandler(void) {
	if (cfHandler == nil) cfHandler = [CFURLHandler new];
	[[NSAppleEventManager sharedAppleEventManager] setEventHandler:cfHandler
		andSelector:@selector(handle:withReply:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
}

// Registered as early as possible too, so the link that launched the app is not missed.
__attribute__((constructor)) static void cfEarly(void) { cfRegisterURLHandler(); }

// Hidden mode: no status item, but the app still needs its event loop to receive links.
static void cfRunHidden(void) {
	[NSApplication sharedApplication];
	[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
	[NSApp run];
}
*/
import "C"

import "sync"

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
