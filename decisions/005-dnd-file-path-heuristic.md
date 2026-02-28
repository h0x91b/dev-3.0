# 005 — Drag-and-drop file path resolution is heuristic

## Context

The terminal supports drag-and-drop: user drops a file onto the terminal, and the app pastes the full file path. However, WKWebView (Electrobun's renderer) does not expose native file paths in drag-and-drop events — the browser File API only provides `file.name`, `file.size`, and `file.lastModified`.

## Investigation

- Electrobun has no API to intercept native drop events at the main process level.
- WKWebView strips the path for security reasons — this is a WebKit limitation, not an Electrobun bug.
- The only metadata available from the browser File API: `name`, `size`, `lastModified`, `type`.

## Decision

We use **macOS Spotlight (`mdfind`)** to search the filesystem by filename, then verify candidates using `size` and `lastModified` from the File API.

**Code:** `src/bun/rpc-handlers.ts` → `resolveFilename()`, called from `src/mainview/TerminalView.tsx` → `handleDrop()`.

**Algorithm:**
1. `mdfind kMDItemFSName == "filename"` — get all paths with this name
2. If one result → return it
3. If multiple → filter by `Bun.file(path).size === file.size`
4. If still multiple → narrow by `Bun.file(path).lastModified === file.lastModified`
5. Fallback → first size-matched candidate, or first mdfind result

## Risks

- **macOS only.** `mdfind` is a macOS tool. Linux/Windows will need a different strategy (e.g., `locate`, `Everything` search, or asking the user to grant file access).
- **Spotlight indexing lag.** Freshly created or downloaded files may not be indexed yet — `mdfind` won't find them.
- **Size/mtime collisions.** Two files with the same name, size, and mtime will still resolve ambiguously.
- **No path at all for unindexed locations.** Directories excluded from Spotlight (e.g., `node_modules`, external drives) won't return results.

## Alternatives considered

- **Electron-style `webkitGetAsEntry()`** — not available in WKWebView.
- **Prompting user to grant folder access** — too much friction for drag-and-drop.
- **Custom native plugin for Electrobun** — would solve the problem properly but requires C/ObjC work and Electrobun doesn't support native plugins yet.
