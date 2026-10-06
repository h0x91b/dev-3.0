// dev3-window-menu — registers our Window submenu as NSApp.windowsMenu.
//
// Electrobun's setApplicationMenu builds the menu bar and calls setMainMenu:,
// but never setWindowsMenu:. Without it AppKit does not know which menu is the
// Window menu, so it injects none of its own items there: the window list and,
// on macOS 15+, Fill / Center / Move & Resize / Full Screen Tile / "Move to
// <display>". Those come from the OS, gated by OS version and connected
// displays — this shim only points AppKit at the menu and adds nothing itself.
//
// Threading: Electrobun builds the menu in a dispatch_async block on the main
// queue. Our block is queued after it (the caller invokes us right after
// setApplicationMenu), so FIFO order guarantees the new main menu exists.
//
// Built by scripts/build-native-macos.sh into dist/native/dev3-window-menu.dylib.

#import <AppKit/AppKit.h>

// The Window menu is the submenu holding the Minimize item. Matching on the
// action, not the title, keeps this independent of the menu label.
static NSMenu *findWindowMenu(NSMenu *mainMenu) {
	for (NSMenuItem *top in mainMenu.itemArray) {
		NSMenu *submenu = top.submenu;
		if (submenu == nil) continue;
		for (NSMenuItem *item in submenu.itemArray) {
			if (item.action == @selector(performMiniaturize:)) return submenu;
		}
	}
	return nil;
}

void dev3_window_menu_adopt(void) {
	dispatch_async(dispatch_get_main_queue(), ^{
		@autoreleasepool {
			NSMenu *windowMenu = findWindowMenu(NSApp.mainMenu);
			if (windowMenu != nil && NSApp.windowsMenu != windowMenu) {
				NSApp.windowsMenu = windowMenu;
			}
		}
	});
}
