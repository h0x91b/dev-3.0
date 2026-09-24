// dev3-mouse-nav — forwards macOS swipe events to the Bun process as back/forward.
//
// Mouse drivers such as Logi Options+ map a mouse's Back/Forward buttons to an
// NSEventTypeSwipe, not to mouse buttons 3/4. WKWebView never turns a swipe into
// a DOM event, so the renderer's side-button handler cannot see it; browsers go
// back on it because they implement -swipeWithEvent: themselves. This shim
// installs an app-local NSEvent monitor for swipes and reports the horizontal
// direction to a Bun JSCallback: +1 for deltaX > 0 (Back), -1 for deltaX < 0
// (Forward). The event is passed through untouched.
//
// Threading: the monitor must be installed on the AppKit main thread, while
// dev3_mousenav_init is called from the Bun worker — hence the dispatch to the
// main queue. The callback is a threadsafe JSCallback taking only an int, so
// nothing needs to outlive the handler.
//
// Built by scripts/build-native-macos.sh into
// dist/native/dev3-mouse-nav.dylib and bundled under Resources/app/native/.

#import <AppKit/AppKit.h>

typedef void (*dev3_mousenav_cb)(int direction);

static id gMonitor = nil;
static dev3_mousenav_cb gCallback = NULL;

int dev3_mousenav_init(dev3_mousenav_cb cb) {
	if (cb == NULL) return 0;
	gCallback = cb;
	dispatch_async(dispatch_get_main_queue(), ^{
		if (gMonitor != nil) return;
		gMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskSwipe
		                                                 handler:^NSEvent *(NSEvent *event) {
			CGFloat dx = event.deltaX;
			dev3_mousenav_cb callback = gCallback;
			if (callback != NULL && dx != 0) callback(dx > 0 ? 1 : -1);
			return event;
		}];
	});
	return 1;
}
