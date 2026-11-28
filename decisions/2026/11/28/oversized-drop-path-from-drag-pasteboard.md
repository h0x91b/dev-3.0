# Oversized drops paste the original path, read from the macOS drag pasteboard

## Context

Dropped files are uploaded into the worktree (`worktree-uploaded-dnd-files`), capped at 100 MB per file. Past the cap the drop only showed an error, although on the desktop the file is already on the host disk and the agent could read it in place. WKWebView still gives the page no host path in drop events.

## Investigation

The drag source (Finder) writes the dragged file URLs to `NSPasteboardNameDrag` when the drag starts, and they stay there after the drop until the next drag begins. A probe built against AppKit read real Finder paths (unicode, spaces, parentheses) back from that pasteboard well after the drop, and the shim below returned the same list through Bun FFI. The pasteboard can be stale (an earlier drag) or hold promised files with no URL, so a bare read is not proof.

## Decision

`src/native/macos/dev3-drag-paths.m` returns the drag pasteboard's file paths; `src/bun/drag-file-paths.ts` (`matchDroppedFiles`) pairs each oversized `File` with the single candidate whose NFC basename, byte size and mtime (±1 s) match, otherwise null. The renderer (`src/mainview/utils/droppedFiles.ts`) asks via `resolveDroppedFilePaths` only for files over the cap, inserts a matched path double-quoted for the pane's shell, and keeps an error toast either way. Linux (WebKitGTK) and Windows (WebView2) return null — Electrobun exposes neither GTK drag data nor WebView2's `postMessageWithAdditionalObjects` — so they keep the plain error. Remote mode never asks: the file is on the viewer's device.

## Risks

A same-name, same-size, same-mtime file dragged earlier from another folder could match if the current drag left no URLs on the pasteboard; that needs three coincidences and still names a real file with identical metadata. The pasteboard is read off the AppKit main thread, which NSPasteboard tolerates in practice. The shim is absent in dev builds that skipped `build-native-macos.sh`; the loader then returns null.

## Alternatives considered

Re-adding Spotlight/`mdfind` lookup by name was rejected for the same reason the 2026-04-16 record removed it: heuristic. Hooking `performDragOperation:` on Electrobun's WKWebView would need swizzling a view the framework owns. Streaming uploads past 100 MB would still duplicate multi-GB files into the worktree.
