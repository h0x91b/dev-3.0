// dev3-drag-paths — reads the file paths on the macOS drag pasteboard.
//
// WKWebView hands a dropped file to the page as a File without its host path.
// The drag source (Finder) writes the file URLs to NSPasteboardNameDrag at drag
// start, and they stay there after the drop until the next drag begins, so the
// host can read them back. The caller matches them to the dropped File by name,
// size and mtime — see decisions/2026/11/28/oversized-drop-path-from-drag-pasteboard.md.
//
// Built by scripts/build-native-macos.sh into dist/native/dev3-drag-paths.dylib.

#import <AppKit/AppKit.h>
#include <string.h>

// Writes the paths as NUL-terminated UTF-8 strings back to back into `buffer`.
// Returns the byte count written, or -(bytes needed) when `capacity` is too small.
int32_t dev3_drag_file_paths(char *buffer, int32_t capacity) {
	@autoreleasepool {
		NSPasteboard *pasteboard = [NSPasteboard pasteboardWithName:NSPasteboardNameDrag];
		NSArray<NSURL *> *urls = [pasteboard readObjectsForClasses:@[ [NSURL class] ]
		                                                   options:@{ NSPasteboardURLReadingFileURLsOnlyKey : @YES }];
		NSMutableData *out = [NSMutableData data];
		for (NSURL *url in urls) {
			const char *path = url.path.fileSystemRepresentation;
			if (path == NULL) continue;
			[out appendBytes:path length:strlen(path) + 1];
		}
		if (out.length > INT32_MAX) return 0;
		int32_t needed = (int32_t)out.length;
		if (needed > capacity) return -needed;
		if (needed > 0) memcpy(buffer, out.bytes, out.length);
		return needed;
	}
}
