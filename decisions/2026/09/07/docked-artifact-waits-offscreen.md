# A docked artifact viewer waits offscreen instead of falling back to the popup

## Context

`decisions/2026/09/07/artifact-panel-default-popup-opt-in.md` made the docked panel the
default: `App` mounts one `TaskArtifactViewer` and it portals into the slot
`TaskWorkspacePane` publishes through `utils/artifact-dock`. No slot means popup — the rule
that lets the archived task modal and an off-screen task's toast reuse the same viewer.

The same rule fired on plain navigation. `artifactViewer` state in `App.tsx` is cleared only
by an explicit close, so pressing ⌘2 with a panel open unmounted the pane, cleared the slot,
and re-hosted the live viewer as a centred popup over an unrelated project's board. Before
the panel existed the leak was invisible: a popup blocks the screen, so it was always closed
by hand. A panel is not in the way, so nobody closes it, and the fallback became the bug.

## Investigation

`grep setArtifactViewer src/mainview/App.tsx` finds four sites — three opens and one close —
and none of them is route-driven; `TaskArtifactViewer.tsx` decides presentation with
`modal = !dock || fullscreen`. Together those two facts are the whole mechanism.

## Decision

A third presentation, **offscreen**. `App` computes `artifactOffscreen` (route's task, from
`routeTaskId`, is not the viewer's) and the viewer renders `card` inside a `hidden` wrapper
instead of the popup, owning no overlay layer, no ⌘F, no Escape and no terminal blanking.
It stays mounted, so returning to the task re-docks the same viewer with its document,
version pick and unsent draft.

Two viewers are exempt, both marked `paneless` on the state: one opened from the task detail
modal (`SharedOutputsList`, `TaskArtifacts paneless`), and one opened while its task was not
on screen — neither has a task screen to wait for, so hiding it would swallow the artifact.
`paneless` also keeps the slot closed for them. The `openArtifactsInPopup` opt-in is
untouched: a popup the user asked for stays a popup.

## Risks

A hidden panel is still open, and the only cue is the Artifacts badge — a user may not
realise the artifact will reappear on return. The republish path (`rpc:cliShowArtifact`)
therefore treats a hidden viewer as closed and raises its toast instead of updating a panel
nobody can see. Moving between the dock, the hidden wrapper and the popup is a DOM move, so
the iframe reloads each time; that already applied to the preference flip.

## Alternatives considered

**Clear `artifactViewer` when the route leaves its task** — three lines, but it throws away
the loaded document, the selected version and an unsent form draft, which is exactly what the
one-viewer design was built to keep. **Never fall back to the popup** — would break the
archived task modal and the toast for an off-screen task, which have no slot by nature.
