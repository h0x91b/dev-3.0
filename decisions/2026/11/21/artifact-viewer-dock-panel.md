# The artifact viewer is the task dock's built-in panel

## Context
Plan item 5.2: after 5.1 the dock ran on the `taskPanels` slot, but the artifact viewer still lived in `App` state (`useState` + derived `artifactDockTaskId` / `artifactOffscreen`), reached the pane through a `dockArtifact` prop chain, and docked through `utils/artifact-dock.ts`. The bible also said immersive shows the popup, while in fact the App-mounted viewer sat inside the immersive chrome gate and unmounted.

## Decision
- `task-panels/artifact-panel.tsx` owns the one viewer's state (`showArtifactViewer`, `closeArtifactViewer`, `isArtifactViewerShowing`, `setArtifactPopupPreference`) and keeps the `builtin:artifact` panel open for that task only. `ArtifactPanel` renders `TaskArtifactViewer`: docked into the panel's own element, a popup portalled to `body` when the panel floats or the task is on screen without a dock (narrow, immersive), hidden when its task has no seat or another tab is in front.
- The dock store gained **floating** panels: open, no tab, the panel draws itself as a lightbox. The viewer floats when paneless or under `openArtifactsInPopup`; flipping the preference re-hosts the same instance.
- Opening or republishing brings the artifact tab to the front. `App` keeps its listeners (bell, toast, navigation, mark-read) and only calls the module, plus one effect mirroring the preference. `utils/artifact-dock.ts`, `dockArtifact` and the App state are deleted; `TaskArtifactViewer` takes `dock` as a prop.
- `TaskPanelInstances` now receives the loaded project's tasks and hands panels their `task` record (review pins, live page).

## Risks
- "On screen" is now the seat: a pane mounted for the task. Every mount site renders `TaskDock`, so this matches `routeShowsTaskWorkspace`; a future workspace surface without `TaskDock` would read as offscreen.
- Focus after close goes to the terminal when the task has a seat, else to the badge — the same rule, keyed on the seat instead of the route.

## Alternatives considered
- A separate App-level host for the popup and the panel for the dock — two hosts break "one viewer, re-hosted on a flip".
- Moving the CLI/open listeners into the module — they need the route, bells and toasts, which belong to `App`.
