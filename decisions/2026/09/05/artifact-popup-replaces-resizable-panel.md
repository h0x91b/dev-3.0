# HTML artifacts open as a popup; the resizable panel is deleted

## Context

`dev3 show-artifact` used to open the artifact in a panel docked to the right of the task
terminal, with a drag handle between them (`TaskWorkspacePane.tsx`). Dragging that handle a
couple of times could wedge the whole UI — the app stopped repainting and stayed that way.
Every pointer move sat on a path that relaid out an opaque-origin iframe and refit the ghostty
terminal beside it (SIGWINCH → full TUI repaint); the shipped code already tried to defuse that
with a ghost line and a single commit on pointer up, and it still froze.

Meanwhile `dev3 show-image` has always opened its lightbox over the task — a centred card on a
scrim, Escape to close, fullscreen on demand — and nobody has ever reported it freezing,
because it never resizes anything behind it.

## Decision

Artifacts open exactly like images: `TaskArtifactViewer` is now the same windowed lightbox as
`TaskImageViewer` — same scrim, same `~90%` card, same fullscreen toggle, same overlay-layer
Escape unwind — hosted by `App.tsx` for every entry point (task workspace, archived task modal,
toast). The `standalone` prop is gone because there is only one mode now.

The docked surface and everything that served it are deleted, not deprecated: the width state
and its `dev3-artifact-panel-width` localStorage key, the pointer-capture resize session, the
ghost line and the drag shield, the `role="separator"` handle, the clamp-on-container-resize
effect, and the `artifactViewer` / `onCloseArtifactViewer` props threaded through
`ProjectView` → `TaskWorkspaceView` → `TaskWorkspacePane`. The workspace pane no longer has a
split at all, which is what `TaskWorkspaceView.test.tsx` now asserts — the freeze path cannot
be reached because it does not exist.

Two details that are deliberate rather than oversights:

- **No focus trap**, unlike the image lightbox. An artifact can draw a form the user answers
  and sends to the agent, and the sandboxed iframe is not in the trap's tabbable set, so a trap
  would make that form unreachable by keyboard. Escape and the scrim click still close it.
- **`<html data-artifact-viewer>` is now `"open"`, not `"fullscreen"`.** The WKWebView WebGL
  overlay-plane workaround in `index.css` used to be needed only in fullscreen because the
  docked split kept the terminal legitimately visible. A modal card over a scrim needs it in
  both sizes, exactly like `data-image-viewer="open"`.

## Risks

The panel could be watched next to a live terminal; the popup covers it. That is the trade the
ruling accepted — the terminal is one Escape away and is exactly where it was left. Anyone who
had dragged the panel to a favourite width loses it, and the stored key is now dead data in
their `localStorage` (harmless, never read again).

## Alternatives considered

- **Keep the panel, fix the freeze.** Rejected by the user as a product decision: while the
  resize path exists it can regress, and the sibling investigation task had not yet named a
  single root cause worth defending the surface for.
- **Keep the panel but drop only the drag handle** (fixed width, keyboard-only resize). Leaves
  two viewer shapes to maintain and still relayouts the iframe on window resize, for no gain
  over reusing a pattern that already works.
