# The artifact viewer is the task dock's built-in panel

## Context
Plan item 5.2: after 5.1 the dock ran on the `taskPanels` slot, but the artifact viewer still lived in `App` state (`useState` + derived `artifactDockTaskId` / `artifactOffscreen`), reached the pane through a `dockArtifact` prop chain, and docked through `utils/artifact-dock.ts`. The bible also said immersive shows the popup, while in fact the App-mounted viewer sat inside the immersive chrome gate and unmounted.

## Decision
- `task-panels/artifact-panel.tsx` owns the one viewer's state (`showArtifactViewer`, `closeArtifactViewer`, `isArtifactViewerShowing`, `setArtifactPopupPreference`) and keeps the `builtin:artifact` panel open for that task only. `ArtifactPanel` renders `TaskArtifactViewer`: docked into the panel's own element, a popup portalled to `body` when the panel floats or the viewport is too narrow for a dock, hidden when its task has no seat. Behind another tab it stays portalled into its (hidden) dock element, so the iframe is not re-created on a tab switch.
- **Immersive is offscreen, not popup.** The pane marks the dock `covered` in immersive, so the viewer waits hidden and mounted, `isArtifactViewerShowing` is false. A republish while the window is focused stays silent apart from the bell (the route still shows the task, as on main) and the viewer is there on exit; unfocused, it raises the usual toast, whose click leaves fullscreen. A popup there would only ever appear unrequested over the terminal the user just fullscreened. The bible line that said "immersive → popup" was changed to match.
- **A crashed viewer can be dismissed.** The panel wraps the viewer in its own boundary whose reset key bumps on every `showArtifactViewer`; its notice carries a Close that calls `closeArtifactViewer` and, for a floating viewer, sits over the page because the panel host is hidden. The generic host notice for a crashed built-in also got a Close.
- The dock store gained **floating** panels: open, no tab, the panel draws itself as a lightbox. The viewer floats when paneless or under `openArtifactsInPopup`; flipping the preference re-hosts the same instance.
- Opening or republishing brings the artifact tab to the front. `App` keeps its listeners (bell, toast, navigation, mark-read) and only calls the module, plus one effect mirroring the preference. `utils/artifact-dock.ts`, `dockArtifact` and the App state are deleted; `TaskArtifactViewer` takes `dock` as a prop.
- `TaskPanelInstances` now receives the loaded project's tasks and hands panels their `task` record (review pins, live page).

## Risks
- "On screen" is now the seat: a pane mounted for the task. Every mount site renders `TaskDock`, so this matches `routeShowsTaskWorkspace`; a future workspace surface without `TaskDock` would read as offscreen.
- Focus after close goes to the terminal when the task has a seat, else to the badge — the same rule, keyed on the seat instead of the route.

## Alternatives considered
- A separate App-level host for the popup and the panel for the dock — two hosts break "one viewer, re-hosted on a flip".
- Moving the CLI/open listeners into the module — they need the route, bells and toasts, which belong to `App`.
