# Task dock panels on an internal `taskPanels` slot

## Context
Plan item 5.1 (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): the right-hand dock of the task workspace held exactly one thing, the artifact viewer, through `utils/artifact-dock.ts` — App mounts the viewer, the pane only offers it an element. Bible §5.12/§9 wants one dock for many panels: one tab strip, four visible tabs, then "More". Internal first: built-ins only, no manifest kind, no public service, no version bump.

## Decision
- `src/mainview/task-panels/registry.ts`: `TaskPanelsRegistry`, a contribute-kind `SlotRegistry` of `TaskPanelDef` (`title(t)`, `component`, optional `closable: false`).
- `task-panels/dock-store.ts`: per task, the open panels (opening order) and the front tab; the user's last pick per task is remembered in `localStorage` (`dev3-task-dock-active`, capped at 200 tasks). Open panels are not persisted — whoever opened a panel reopens it. Panes publish a per-task **seat**: the dock body, `null` when the task is on screen without room for a dock (narrow, immersive), nothing when it is off screen or under the inline diff.
- `task-panels/TaskPanelInstances.tsx`, mounted once in `App`, generalises the artifact-dock pattern: every open panel of every task is rendered there into its own persistent element, which is moved into the seat or into a hidden parking element. React never sees the portal container change, so a panel keeps its state across tab switches, task switches and narrow/immersive flips (the layer sits outside the immersive chrome gate for that). Its `presentation` (`docked | inactive | undocked | offscreen`) tells it where it stands.
- `task-panels/TaskDock.tsx` is the column (resize code moved from `TaskWorkspacePane`, same width key) with the tab strip, shown from two open panels or for one closable panel (its ✕). Tabs follow `placeSlotItems`: built-ins first by `order` and never folded into More; extensions in opening order share the rest of the four. The front tab is re-resolved (`resolveActiveTab`) against what is registered, so the strip always has a selected tab.
- A crashed built-in panel keeps its tab with an inline notice; a crashed extension panel closes its tab (bible §5.12, same split as settings sections). The More menu mirrors `SlotItems`' overflow keyboard and trigger style but is not shared: its rows are tab picks, not slot items with their own components.
- The artifact viewer is the first built-in panel only as a **bridge** for now: its panel publishes the old `artifact-dock` element while the dock is on screen, and App still owns the viewer and its state (`dockArtifact` opens the tab). Plan item 5.2 moves the viewer into the panel and deletes `artifact-dock.ts`. Found in QA: on `main` the App-mounted viewer sits inside the immersive chrome gate, so in immersive it is unmounted rather than a popup as the bible says; 5.2 fixes that by making it an `undocked` panel.

## Risks
- Hidden panels stay mounted per task until closed; a heavy panel left open in many tasks costs memory. Moving a panel's element in the DOM reloads any iframe inside it.
- Built-ins may use internals (recorded tech debt); `TaskPanelProps` must not become the public contract as is.

## Alternatives considered
- Rendering panels inside the pane — simpler, but every task switch remounts them, so nothing survives a switch.
- Swapping `createPortal` targets between dock and parking — React remounts a portal whose container changes; one persistent element moved in the DOM avoids it.
- Persisting open panels per task — the artifact bridge would reopen an empty tab after a restart.
