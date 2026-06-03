# UX Decisions

Append-only log of UX architecture decisions. Each entry: date, decision, rationale, evidence/status.

## 2026-06-03 — Cmd+1..9 preserves the current view mode (task-view vs board)

- **Decision:** The `Cmd/Ctrl+1..9` project-switch shortcut now preserves the user's current *view mode* instead of always dropping them on the Kanban board. If the user is in a task view when they switch (split layout: `screen: "project"` with `activeTaskId`, or the full-page `screen: "task"`), the target project opens in task view too — `ActiveTasksSidebar` shows the new project's active tasks and, because no task is selected there yet, the terminal pane shows a centered empty-state: «Select a task to see its terminal». If the user is on the board (no active task), switching keeps the board. A new `taskView?: boolean` flag on the `project` route models "task-view layout with no task selected". The empty-state is a *status surface* (Toast/empty-state family), not an action — centered `text-fg-muted` text, no button (selecting a task in the sidebar fills the terminal).
- **Rationale:** The app is keyboard-heavy and users live inside the task view; yanking them to the board on every workspace switch breaks flow. Preserving view mode matches how Slack-style `Cmd+N` switching should feel. Empty terminal must be explicit ("pick a task") rather than auto-selecting one — the user asked for an empty pane, not a guessed task, so no implicit selection happens.
- **Status:** `Observed` (implemented: `App.tsx` Cmd+1..9 + Escape handlers, `ProjectView.tsx` split layout + empty-state, `state.ts` `taskView` flag, i18n key `project.selectTaskForTerminal`).

## 2026-05-29 — Initial manifest derived from repository

- **Decision:** Treat dev-3.0 as a full-screen desktop web app with a **screen-based navigation model** (the `Route` union in `src/mainview/state.ts`), not a URL-routed site. The manifest's "routes" are screen ids.
- **Rationale:** There is no URL router; navigation is `useReducer` + back/forward history. Modeling it as URL routes would be fiction.
- **Status:** `Observed`.

## 2026-05-29 — Button variants documented as role → token, not as a prop

- **Decision:** Document button semantics by semantic role mapped to Tailwind token classes (`bg-accent` = primary, `text-danger`/`bg-danger` = destructive, ghost = hover surface) rather than a `<Button variant>` API.
- **Rationale:** No formal Button component or `variant` prop exists; buttons are styled inline. AGENTS.md forbids hardcoded colors and mandates semantic tokens.
- **Status:** `Observed`.

## 2026-05-29 — Native application menu is the canonical action surface

- **Decision:** Treat the Electrobun application menu (`src/bun/application-menu.ts`) as the authoritative, complete action taxonomy; DOM toolbars mirror only the frequent subset.
- **Rationale:** The native menu enumerates every File/Edit/Task/Project/View/Debug action; DOM surfaces are intentionally partial to control density.
- **Status:** `Observed`.

## 2026-05-29 — Toolbar button creep flagged as the primary anti-pattern

- **Decision:** Set explicit complexity budgets and require an overflow/group decision before adding visible buttons to `TaskInfoPanel`, `TaskCard`, or board toolbars.
- **Rationale:** Changelog history shows a steady accretion of always-visible git/tmux/dev-server buttons; these are the densest, highest-risk surfaces.
- **Status:** `Inferred` (from changelog + file sizes).

## 2026-06-03 — Prevent-sleep surfaced as a header toggle with a new `--awake` token

- **Decision:** Surface the existing `preventSleepWhileRunning` setting as a prominent header toggle (`PreventSleepToggle`) placed immediately left of Home Terminal, using a coffee glyph and a new semantic `--awake` (amber) token defined in both themes. Default on. While remote access is active (Cloudflare tunnel connected or a browser client attached) it is forced on and locked. Semantics changed: when enabled, sleep is inhibited for the whole time the app runs (driven by the resource-monitor poll), not only while agents are active.
- **Rationale:** The feature was buried in Settings and invisible. The user wanted an obvious, always-visible control and "machine never sleeps while remote." Amber/coffee reads as "awake" and is distinct from `--warning`. Remote-active detection lives in `remote-access-server.isRemoteAccessActive()`; it is imported lazily inside the resource-monitor poll to keep that module free of electrobun-heavy imports.
- **Status:** `Observed` (implemented: `PreventSleepToggle.tsx`, `caffeinate.ts`, `app-handlers.ts`, `index.css`/`tailwind.config.js`).

## 2026-06-03 — TaskInfoPanel governed by a 4-bar 2×2 domain model

- **Decision:** The inspector header is a 2×2 grid of quickbars (2 rows × left|right), one bar per action domain: Context (row1-left), Session/Agent (row1-right), Git (row2-left), Runtime (row2-right). Panel chrome (collapse/fullscreen/⚙) is pinned to row-1 far-right and is **not** a bar. Moved `dev-server` + `scripts` out of the overloaded row-1-right cluster into the previously unused row-2-right (next to Git). Labels in the Context bar truncate to 4 inline chips + a `+k` chip. See bible §5.1.
- **Rationale:** Row-1-right had become a dumpster mixing 4 domains (agent, terminal, dev-server, panel-nav). Wide desktop width lets each row carry a left+right bar, so domains separate cleanly without adding rows (the panel has a hard `MAX_RATIO=0.33` height budget). Row 1 = "Drive", row 2 = "Outputs".
- **Status:** `Observed` (implemented in `TaskInfoPanel.tsx`).

## 2026-06-03 — macOS dock-persistence + React quit-confirmation modal

- **Decision:** The app follows standard macOS lifecycle: `exitOnLastWindowClosed: false`, so closing the last window keeps it alive in the dock (reopened via the `reopen` event → `openMainWindow` when window count is 0); closing windows is not quitting. The "sessions keep running" quit confirmation is a React modal (Modal surface) driven by a single `before-quit` gate, fired on every deliberate quit — Cmd+Q (renderer catches the keystroke and forwards via `requestQuit`, since WKWebView swallows the native accelerator), menu Quit, dock Quit. If a window is open the gate pushes the dialog to it; if the app is window-less it reopens a window which **pulls** the pending flag on mount (`consumePendingQuitDialog`) and shows the dialog. No native `showMessageBox` (wrong for the remote client). New Window also gets a Cmd+Shift+N renderer shortcut. Decision records 044 (multi-window/dock-persistence), 061 (quit gate), 060 (shared-PTY resize).
- **Rationale:** One confirmation for every deliberate quit, kept in React so it works identically in the remote client. The native window-close is not interceptable, so a window-less quit must reopen a window to host the dialog; the pull-on-mount handshake makes that reliable (an earlier push raced the renderer mount and was lost). The brief reopen flash is accepted because the user wants the warning on every real quit.
- **Status:** `Observed` (implemented: `electrobun.config.ts` runtime flag, `App.tsx`, `src/bun/index.ts` gate + reopen handler, `quit-manager.ts`, `app-handlers.ts` `requestQuit`/`quitApp`/`consumePendingQuitDialog`/`openNewWindow`).

## 2026-06-03 — Hide-sidebar affordance inside the Active Tasks sidebar header

- **Decision:** Add an icon-only "hide sidebar" button to the far-right of the `ActiveTasksSidebar` header action cluster (after the switch-to-board button), rendered only when an active task is set. It mirrors the fullscreen/"Zoom" chrome toggle in `TaskInfoPanel` (same enter-fullscreen SVG, `icon`/`ghost` role, `text-fg-muted hover:text-accent`) and `navigate({ screen: "task", … })` to collapse the split into the full-page terminal. Re-expanding stays on the existing top-bar toggle.
- **Rationale:** The split could only be collapsed from the top-right; the sidebar itself had no affordance to hide. The control governs the panel (chrome), so it sits at the panel-chrome convention's far-right edge. The sidebar header is not under the §5.1 2×2 bar model — it follows the toolbar budget (≤4 visible), which a single added icon respects.
- **Status:** `Observed` (implemented in `ActiveTasksSidebar.tsx`; key `sidebar.hide` in en/ru/es).
