# Archived tasks list their shared images and artifacts, and Escape unwinds through the layer stack

## Context

A completed task's `sharedImages` / `sharedArtifacts` survive the worktree — both live under
`~/.dev3.0/worktrees/{slug}/shared-images|shared-artifacts/`, siblings of the per-task worktree
directory that cleanup removes. The records stay on the task in `tasks.json`. The only entry
points, though, were the live task's Runtime-bar count badges (`TaskSharedImages.tsx`,
`TaskArtifacts.tsx`) — an archived task has no Runtime bar, so the files were unreachable
without re-running the task.

## Investigation

Two blockers surfaced beyond "render a list":

1. **The artifact viewer had no host outside the task workspace.** `TaskArtifactViewer` is a
   docked sibling of the terminal inside `TaskWorkspacePane`; App's `artifactViewer` state was
   only ever handed down to a view that renders that pane. Dispatching
   `dev3:openArtifactViewer` from the Kanban board set state that nothing rendered.
2. **Escape closed the modal underneath instead of the viewer.** `useEscapeKey` is a
   capture-phase `window` listener that calls `stopImmediatePropagation()`, so the listener
   registered *first* wins — and the archived modal always mounts before the viewer it opens.
   Both viewers had their own private capture listeners, which therefore never ran.

## Decision

- `SharedOutputsList.tsx` — enumerated rows (name + caption + timestamp), rendered in
  `TaskDetailModal`'s `ArchivedView` above Notes. No thumbnails: up to 30 images would mean 30
  `readImageBase64` round-trips on modal open, and the viewer's own thumbnail rail already
  covers visual browsing.
- `TaskArtifactViewer` gained `standalone`: overlay layout forced, fullscreen toggle dropped
  (there is no pane to dock back into), Escape closes outright. The request carries
  `standalone: true` on the event; `App.tsx` hosts it directly and stops handing it to the
  views (`artifactViewer={artifactViewer?.standalone ? null : artifactViewer}`).
- Escape moved to the overlay-layer stack (`registerOverlayLayer`): unconditionally in
  `TaskImageViewer` (it already owned the keyboard unconditionally), and only when `standalone`
  in `TaskArtifactViewer`. The staged unwind lives in the layer's `onDismiss`.

## Risks

- The artifact viewer's docked Escape path is deliberately untouched — it stays gated on focus
  being inside the viewer, so an Escape typed into the terminal beside it does not close the
  panel. Registering the docked viewer as a layer would break exactly that.
- `TaskImageViewer` no longer has a private Escape branch. If a future caller renders it
  without the element the focus-trap ref points at, the layer never registers and Escape falls
  through to whatever is underneath.

## Alternatives considered

- **Reuse the Runtime-bar count badges in the modal.** One click, no enumeration — the ask was
  explicitly links to *all* of them.
- **Render the artifact viewer inside the modal's own tree.** Avoids the App plumbing but gives
  artifacts a second host with its own lifecycle, and the read-marking RPC would have to be
  duplicated at the call site.
- **Make `useEscapeKey` skip modals that have an overlay on top.** A global ordering rule for
  one case; the layer stack already exists for exactly this and is opt-in per overlay.
