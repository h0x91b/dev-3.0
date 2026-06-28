# 084 — Escape must call preventDefault to close overlays in native fullscreen

## Context
When the app ran in macOS native fullscreen, pressing Escape often exited
fullscreen instead of closing the open modal/lightbox. Many overlays had an
Escape handler that called `onClose()` but never `e.preventDefault()`.

## Investigation
In WKWebView (Electrobun), a keydown that the web layer does not consume is
forwarded up the AppKit responder chain. For a fullscreen `NSWindow`, AppKit
interprets the Escape key as `cancelOperation:` → exit fullscreen. `onClose()`
alone closes the React overlay but leaves the native default intact;
`stopPropagation`/`stopImmediatePropagation` only stop JS listeners, not the
native default action. Only `e.preventDefault()` suppresses it. This explained
why some overlays "worked" — those whose focused input already preventDefaulted
Escape (e.g. textarea edit handlers, the command palette) — and most did not.

## Decision
Added `src/mainview/hooks/useEscapeKey.ts`: a capture-phase `window` keydown
listener that, on Escape, calls `preventDefault()` + `stopImmediatePropagation()`
then a ref-held callback (no deps array). Capture beats App's global bubble-phase
back-nav handler (`App.tsx`) and focused elements; staging (dropdown → inline
edit → close) lives inside the callback. Routed every overlay through it
(TaskDetailModal, ImageLightbox, BugHuntersLightbox, Add/CreateTask, FolderPicker,
Spawn/LaunchVariants, KeyboardShortcuts, AboutModal, LabelPicker, OpenInMenu,
SiblingPopover, Tmux popovers, GlobalHeader dropdowns, Changelog, task-info-panel
menus). Inline editors that are not stacked overlays (InlineRename, KanbanColumn
rename, sidebar/filter search, ProjectSettings dropdown, TaskDiffViewer search)
keep their element-level handlers but now also call `preventDefault()`. App's
back-nav handler preventDefaults in the branches where it acts.

## Risks
Capture + `stopImmediatePropagation` pre-empts descendant element Escape handlers
while an overlay is mounted, so any inner sub-state (autocomplete, inline rename)
must be staged inside `onEscape`. Nested overlays unwind outermost-first
(registration order), which matches prior behavior. The terminal still receives
Escape because no overlay listener is active when none is open.

## Alternatives considered
- Add `e.preventDefault()` to each handler in place — fixes fullscreen but leaves
  ~25 ad-hoc handlers that future modals copy, re-introducing the bug.
- A single global listener + LIFO stack (topmost-wins) — cleaner nesting but a
  capture listener forces it to pre-empt all inner element handlers, breaking
  inline editors inside modals; rejected for higher risk.
