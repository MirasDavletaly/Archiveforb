// macOS hands myfiles:// links to an app as "get URL" Apple events, not as program arguments.
// (In its own file: a cgo preamble next to //export may only declare, or the class would be defined twice.)
#import <Cocoa/Cocoa.h>

extern void goHandleURL(char *url);

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

void cfRegisterURLHandler(void) {
	if (cfHandler == nil) cfHandler = [CFURLHandler new];
	[[NSAppleEventManager sharedAppleEventManager] setEventHandler:cfHandler
		andSelector:@selector(handle:withReply:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
}

// Registered as early as possible too, so the link that launched the app is not missed.
__attribute__((constructor)) static void cfEarly(void) { cfRegisterURLHandler(); }

// Hidden mode: no status item, but the app still needs its event loop to receive links.
void cfRunHidden(void) {
	[NSApplication sharedApplication];
	[NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
	[NSApp run];
}
