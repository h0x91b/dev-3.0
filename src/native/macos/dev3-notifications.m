// dev3-notifications — minimal UNUserNotificationCenter shim for the Bun process.
//
// Electrobun's Utils.showNotification is fire-and-forget: its native layer posts
// via UNUserNotificationCenter but never sets a delegate, so notification clicks
// only activate the app — the app cannot tell WHICH notification was clicked
// (upstream: blackboardsh/electrobun#384). This shim owns both sides:
//
//   • posting  — dev3_notif_post() attaches the task target to the request
//     identifier, so a click carries its payload back to us;
//   • clicking — a UNUserNotificationCenterDelegate forwards the clicked
//     request identifier to a Bun JSCallback.
//
// Threading contract: Bun's threadsafe JSCallbacks are fire-and-forget — the JS
// body runs LATER on the Bun worker thread, long after this delegate method (and
// the autoreleased `response` object) is gone. Everything the JS side needs must
// therefore be copied to the heap before the callback returns, and the
// completion handler must be called HERE, synchronously. That is exactly why
// this must be compiled code and cannot be done with pure bun:ffi + libobjc.
//
// Built by scripts/build-native-notifications.sh into
// dist/native/dev3-notifications.dylib and bundled under Resources/app/native/.

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef void (*dev3_notif_click_cb)(const char *identifier);

// 0 = unknown / request pending, 1 = granted, 2 = denied.
static _Atomic int gAuthStatus = 0;

@interface Dev3NotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property (atomic, assign) dev3_notif_click_cb clickCallback;
@end

@implementation Dev3NotificationDelegate

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
    didReceiveNotificationResponse:(UNNotificationResponse *)response
             withCompletionHandler:(void (^)(void))completionHandler {
	// Only the default action (the user clicked the notification body) navigates;
	// dismissals must not teleport the user anywhere.
	if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) {
		dev3_notif_click_cb cb = self.clickCallback;
		if (cb != NULL) {
			const char *utf8 = response.notification.request.identifier.UTF8String;
			// Heap copy — the JS callback reads it asynchronously on the Bun worker
			// thread and frees it via dev3_notif_free_cstr.
			cb(strdup(utf8 != NULL ? utf8 : ""));
		}
	}
	completionHandler();
}

// willPresentNotification is deliberately NOT implemented: an unimplemented
// delegate method keeps the pre-delegate system default (notifications are
// silenced while the app is frontmost), preserving the app's existing UX.

@end

// Strong global so ARC keeps the delegate alive for the process lifetime —
// UNUserNotificationCenter.delegate is a weak reference.
static Dev3NotificationDelegate *gDelegate = nil;

// Returns 1 when the delegate is installed and authorization was requested,
// 0 when UNUserNotificationCenter is unavailable (e.g. no app bundle).
int dev3_notif_init(dev3_notif_click_cb cb) {
	@autoreleasepool {
		// UNUserNotificationCenter requires a real app bundle. In bundle-less
		// processes (plain `bun` runners) +currentNotificationCenter raises
		// NSInternalInconsistencyException from inside a dispatch_once block —
		// the unwind hits libdispatch's noexcept client callout and terminates
		// the process before any @catch can run. The only safe guard is to not
		// touch the framework at all without a bundle identifier.
		if ([[NSBundle mainBundle] bundleIdentifier] == nil) {
			return 0;
		}
		// Belt-and-braces for anything the framework raises synchronously.
		@try {
			UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
			if (center == nil) {
				return 0;
			}
			if (gDelegate == nil) {
				gDelegate = [[Dev3NotificationDelegate alloc] init];
			}
			gDelegate.clickCallback = cb;
			center.delegate = gDelegate;
			[center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound |
			                                         UNAuthorizationOptionBadge)
			                      completionHandler:^(BOOL granted, NSError *_Nullable error) {
				                      atomic_store(&gAuthStatus, granted ? 1 : 2);
			                      }];
			return 1;
		} @catch (NSException *e) {
			gDelegate = nil;
			return 0;
		}
	}
}

int dev3_notif_auth_status(void) {
	return atomic_load(&gAuthStatus);
}

// Posts a notification whose request identifier is the caller's payload.
// Returns 1 when handed to the notification center, 0 when authorization is
// not (yet) granted — the caller falls back to Electrobun's own path then.
int dev3_notif_post(const char *identifier, const char *title, const char *subtitle, const char *body, int silent) {
	if (atomic_load(&gAuthStatus) != 1 || gDelegate == nil) {
		return 0;
	}
	@autoreleasepool {
		@try {
			UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
			content.title = [NSString stringWithUTF8String:(title != NULL ? title : "")];
			if (subtitle != NULL && subtitle[0] != '\0') {
				content.subtitle = [NSString stringWithUTF8String:subtitle];
			}
			if (body != NULL && body[0] != '\0') {
				content.body = [NSString stringWithUTF8String:body];
			}
			if (!silent) {
				content.sound = [UNNotificationSound defaultSound];
			}
			NSString *ident = [NSString stringWithUTF8String:(identifier != NULL ? identifier : "")];
			UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:ident
			                                                                      content:content
			                                                                      trigger:nil];
			[[UNUserNotificationCenter currentNotificationCenter] addNotificationRequest:request
			                                                       withCompletionHandler:nil];
			return 1;
		} @catch (NSException *e) {
			return 0;
		}
	}
}

void dev3_notif_free_cstr(char *p) {
	free(p);
}
