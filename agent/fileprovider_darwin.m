// The Mac's File Provider, as OneDrive uses it: the extension inside the app (CompanyFilesProvider.appex) does the
// work. The app only adds or removes its domain (Finder then shows it on the left, under Locations), tells it when
// the website changed, and asks where it is.
#import <Foundation/Foundation.h>
#import <FileProvider/FileProvider.h>
#include <string.h>

static NSFileProviderDomain *cfDomain(const char *ident, const char *name) {
	return [[NSFileProviderDomain alloc] initWithIdentifier:[NSString stringWithUTF8String:ident]
	                                            displayName:[NSString stringWithUTF8String:name]];
}

static int cfWait(dispatch_semaphore_t s) {
	return dispatch_semaphore_wait(s, dispatch_time(DISPATCH_TIME_NOW, (int64_t)60 * NSEC_PER_SEC)) ? -1 : 0;
}

static void cfCopy(NSString *s, char *out, int outlen) {
	if (out && outlen > 0) strlcpy(out, s ? [s UTF8String] : "", (size_t)outlen);
}

static void cfErr(NSError *e, char *err, int errlen) {
	cfCopy(e ? [NSString stringWithFormat:@"%@ (%@ %ld)", e.localizedDescription, e.domain, (long)e.code] : @"no answer in 60 seconds", err, errlen);
}

int cfFPAdd(const char *ident, const char *name, char *err, int errlen) {
	dispatch_semaphore_t s = dispatch_semaphore_create(0);
	__block NSError *e = nil;
	[NSFileProviderManager addDomain:cfDomain(ident, name) completionHandler:^(NSError *error) {
		e = error;
		dispatch_semaphore_signal(s);
	}];
	if (cfWait(s) || e) {
		cfErr(e, err, errlen);
		return -1;
	}
	return 0;
}

int cfFPRemove(const char *ident, const char *name, char *err, int errlen) {
	dispatch_semaphore_t s = dispatch_semaphore_create(0);
	__block NSError *e = nil;
	[NSFileProviderManager removeDomain:cfDomain(ident, name) completionHandler:^(NSError *error) {
		e = error;
		dispatch_semaphore_signal(s);
	}];
	if (cfWait(s) || e) {
		cfErr(e, err, errlen);
		return -1;
	}
	return 0;
}

// Something changed on the website: the system asks the extension what (its "working set" changes).
int cfFPSignal(const char *ident, const char *name) {
	NSFileProviderManager *m = [NSFileProviderManager managerForDomain:cfDomain(ident, name)];
	if (m == nil) return -1;
	[m signalEnumeratorForContainerItemIdentifier:NSFileProviderWorkingSetContainerItemIdentifier completionHandler:^(NSError *error) {}];
	return 0;
}

// Where Finder shows it (~/Library/CloudStorage/...).
int cfFPRoot(const char *ident, const char *name, char *out, int outlen) {
	NSFileProviderManager *m = [NSFileProviderManager managerForDomain:cfDomain(ident, name)];
	if (m == nil) return -1;
	dispatch_semaphore_t s = dispatch_semaphore_create(0);
	__block NSURL *u = nil;
	[m getUserVisibleURLForItemIdentifier:NSFileProviderRootContainerItemIdentifier completionHandler:^(NSURL *url, NSError *error) {
		u = url;
		dispatch_semaphore_signal(s);
	}];
	if (cfWait(s) || u == nil) return -1;
	cfCopy(u.path, out, outlen);
	return 0;
}

// The folder this app and its extension share (the server address and this computer's token are kept there).
int cfGroupPath(const char *group, char *out, int outlen) {
	NSURL *u = [[NSFileManager defaultManager] containerURLForSecurityApplicationGroupIdentifier:[NSString stringWithUTF8String:group]];
	if (u == nil) return -1;
	cfCopy(u.path, out, outlen);
	return 0;
}
