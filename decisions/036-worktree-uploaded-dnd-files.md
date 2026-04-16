# 036 — Drag-and-drop files are uploaded into the task worktree

## Context

Drag-and-drop in WKWebView never exposes the original host path. The previous `resolveFilename()` workaround depended on macOS Spotlight, was heuristic by design, and could not work consistently in remote/browser sessions.

## Investigation

The renderer already had a reliable upload path for pasted images and remote RPC traffic. Reusing that flow for dropped files gives us the file bytes directly in the browser, which is the only stable cross-platform input we actually control.

## Decision

We removed `resolveFilename()` from `src/bun/rpc-handlers/app-handlers.ts` and replaced the drop flow with `uploadFileBase64()`. `src/mainview/hooks/useFileDrop.ts`, `src/mainview/TerminalView.tsx`, and `src/mainview/utils/uploadDroppedFile.ts` now upload dropped files into `~/.dev3.0/worktrees/<slug>/uploads/` and use the returned server path.

## Risks

This duplicates dropped files into the worktree-managed uploads directory, so disk usage grows with large uploads. The RPC payload is still capped at 10 MB, which keeps the browser/WebSocket path sane but rejects larger drops until we add a streaming path.

## Alternatives considered

Maintaining per-OS path lookup backends (`mdfind`, `locate`, `find`, platform APIs) would stay fragile and still fail in remote/browser mode. Asking the user for extra filesystem permissions would add friction to a basic drag-and-drop action for a result we can already get by uploading the file content.
