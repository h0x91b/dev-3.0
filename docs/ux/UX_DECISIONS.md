# UX Decisions

Append-only log of UX architecture decisions. Each entry: date, decision, rationale, evidence/status.

## 2026-06-15 — Option+Tab task switcher is a transient HUD overlay, NOT a command palette

- **Decision:** Add a keyboard-summoned, transient HUD overlay that hold-cycles between **active** tasks (`ACTIVE_STATUSES`). Bindings: **Option+Tab** = current project's active tasks, **Option+Shift+Tab** = global (all projects). On Linux, where the WM grabs Alt+Tab before the webview, use **Ctrl+Tab / Ctrl+Shift+Tab** (platform-detected). Interaction model: classic alt-tab **hold** — hold the modifier, tap Tab to advance (wrap-around), release the modifier to commit; **arrows ↑/↓** move bidirectionally (Shift is unavailable for reverse because it selects global scope); **Enter** commits / **Esc** cancels / click commits (these also serve as a robust fallback if the WKWebView `keyup` for the modifier is dropped). Order is **MRU, in-memory** (recently-focused tasks first, reset on app reload) so a quick tap-tap toggles the last two — the core alt-tab muscle memory. Scope (project vs global) is a **live toggle**: while the overlay is open, holding Shift widens to all projects and releasing it narrows back to the current project, preserving the highlighted task when it still exists in the new scope. Each row shows **terminal screenshot · task title · overview** (global also shows project name). Commit navigates respecting `dev3-task-open-mode` (split/fullscreen), reusing the Cmd+1..9 logic. New surface `task_switcher` + component `TaskSwitcherOverlay` (planned).
- **Rationale:** Rejected a command palette: the manifest already owns `task_jump` on the **sidebar** surface (`ux-architecture.yaml` sidebar), and a net-new global palette would be the project's #1 anti-pattern (surface creep / "new component for old pattern"). The switcher is an `expert_shortcut` (keyboard) rendering the existing `task_jump` action class as a transient overlay — manifest-consistent, no new navigation, no command runner. MRU over status-priority because the user invoked the alt-tab mental model explicitly ("press many times to pick", quick toggle between two). Arrows for reverse because the user's Option+Shift+Tab scope binding consumes Shift. Linux gets its own binding from the start because Alt+Tab is unreliable there.
- **Status:** `Proposed` (design locked via interview 2026-06-15; not yet implemented).

## 2026-06-15 — Cmd+Shift+1..9 switches project to the OPPOSITE view

- **Decision:** Added `Cmd/Ctrl+Shift+1..9` as the mirror of `Cmd/Ctrl+1..9`. Where the unshifted chord *preserves* the current view mode, the shifted chord *flips* it: from the Kanban board it opens the target project's task view (split layout, empty-terminal placeholder, reusing the `taskView` route flag), and from a task view it opens the target project's board. Feature class is `expert_shortcut`/keyboard — no new visible controls, buttons, or tokens. Not bound in the application menu (consistent with Cmd+1..9; Electrobun can't bind chord accelerators, decision 044). Unlike Cmd+1..9, this chord intentionally ignores the `dev3-task-open-mode` preference — the explicit Shift means "give me the other view".
- **Rationale:** Keyboard-heavy users wanted a one-chord way to reach a project *and* the other layout in a single keystroke, instead of switching then toggling the view. Mirroring the existing shortcut (Shift = inverse) is a predictable expert pattern. macOS reserves Cmd+Shift+3/4/5 for screenshots, so those indices may be swallowed by the OS — documented as a known limitation, not worked around.
- **Status:** `Observed` (implemented: `App.tsx` Cmd+Shift+1..9 handler keyed on `e.code` Digit1..9, reuses `state.ts` `taskView` flag and `ProjectView.tsx` split empty-state; tip `cmd-shift-switch-flips-view`; decision record 068).

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

## 2026-06-03 — Compact (≤1600px) layout for header + task toolbar

- **Decision:** Below a `matchMedia("(max-width: 1600px)")` breakpoint (new `useCompact()` hook), the `GlobalHeader` action cluster and the `TaskInfoPanel` toolbar switch to a compact layout: text labels collapse to icon-only (tooltips kept), and the header's three low-frequency external actions (Website, Report, Change Log) fold into a single "More" (`⋯`) overflow dropdown. Diff badge and status stay labelled. Above the breakpoint the layout is unchanged.
- **Rationale:** On a 14" MacBook (≤1512pt) the labelled, `flex-shrink-0` button rows overflowed and overlapped; on 16" (1728pt) they fit. 1600px cleanly separates the two at default scaling and also fires on window resize. Per the action taxonomy, the rare external links are the correct overflow candidates; frequent/destination controls stay visible as icons. Viewport-based v1; a content-aware (ResizeObserver) upgrade is the planned v2 since a long breadcrumb title can still crowd the header near the boundary. No flex-wrap (vertical space is scarce in a terminal-centric app).
- **Status:** `Observed` (implemented: `useCompact.ts`, `GlobalHeader.tsx`, `TaskInfoPanel.tsx`, `PreventSleepToggle.tsx`, `GitPullButton.tsx`; keys `header.moreActions`/`header.githubLabel` in en/ru/es). See decision record 063.

## 2026-06-10 — AI-initiated task completion uses a blocking, visually distinct confirm dialog

- **Decision:** `dev3 task move --status completed` from an agent does not move the task; it opens the existing imperative `confirm()` modal with a new `agentInitiated` treatment — accent border (`border-accent/40`) plus a badge pill (robot glyph + "AI agent request") — and `danger`-role confirm button labelled "Complete task", cancel labelled "Keep session" with autofocus. The CLI blocks (≤10 min) for the verdict; decline returns documented exit code 6 so the agent learns the user said no. No persistence, no board badge — ephemeral live dialog only (explicit user choice). `cancelled` stays CLI-forbidden.
- **Rationale:** Completing destroys the worktree + tmux session, so the action is destructive and must keep human approval; the AI-identity badge prevents the user from mistaking it for a routine self-initiated confirm and accidentally approving. Reusing the Modal surface and the `task move` verb adds zero new UI chrome and zero new CLI surface.
- **Status:** `Observed` (implemented: `confirm.tsx` `agentInitiated`, `App.tsx` listener, `completion-requests.ts`, `cli-socket-server.ts` `task.requestCompletion`, `task.ts` `requestCompletion`, exit code 6). See decision record 067 and `feature-plans/agent-completion-request.md`.

## 2026-06-11 — Slash skill autocomplete in the new-task description

- **Decision:** Typing `/` at a word boundary in the `CreateTaskModal` description textarea opens an inline suggestion dropdown (Popover-style, anchored under the textarea inside its existing relative wrapper) listing globally installed agent skills, fetched once per modal mount via the new `listAgentSkills` RPC (scans `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` for `*/SKILL.md`, dedup by name). ArrowUp/Down navigate, Enter/Tab/click insert `/skill-name `, Escape dismisses only the dropdown (modal Escape handler checks the autocomplete first). No new visible buttons — input-assist only, so no surface budget is consumed. Tokens: `bg-overlay border-edge` container, `bg-accent/15` active row, `text-fg-muted` descriptions.
- **Rationale:** Task descriptions are agent prompts; users invoke skills by `/name` and should not have to remember exact slugs. An inline completer is the zero-chrome placement; a dedicated "insert skill" button would feed the toolbar-creep anti-pattern. Caret-anchored positioning was rejected as needless complexity for a 4-row textarea.
- **Status:** `Observed` (implemented: `src/bun/skills-catalog.ts`, `listAgentSkills` in `app-handlers.ts`, `useSkillAutocomplete.ts`, `SkillAutocompleteDropdown.tsx`, wired in `CreateTaskModal.tsx`).

## 2026-06-12 — Quiet "behind origin" indicator on the header Git Pull button

- **Decision:** When the project's local `main`/`master` is behind `origin`, the existing `GitPullButton` in `GlobalHeader` shifts to a quiet informational state: accent tint on the existing icon (`text-accent/80 hover:text-accent hover:bg-accent/10`) plus a 6px `bg-accent` dot at the icon's top-right corner; the tooltip gains the behind count (pluralized `kanban.gitPullBehind_*`). No new control, no count badge, no `animate-pulse`, no `bg-accent/15` fill — those louder accent treatments stay reserved for the "Update ready" header indicator. Backend: `getProjectCurrentBranch` now returns `behindOrigin` (local `rev-list` against `origin/<branch>`), with a fire-and-forget `fetchOrigin` throttled to once per 3 minutes so the 15s renderer poll stays network-free.
- **Rationale:** This is a status, not an action — the manifest's `global_header` budget is untouched. Establishes the header convention: *quiet* accent (tint + dot) for ambient "something is available", *loud* accent (filled pill + pulse) only for app-update prompts.
- **Status:** `Observed` (implemented: `GitPullButton.tsx`, `git-operations.ts` `getProjectCurrentBranch`/`maybeRefreshOriginRef`, `git.ts` `getBehindOriginCount`).

## 2026-06-15 — Compact status-age badge on Active Tasks sidebar cards

- **Decision:** Each `ActiveTasksSidebar` card shows a read-only status-age badge on the bottom meta row, pushed to the right (`ml-auto`) next to `#seq` and labels: a clock glyph (``) plus a strictly compact "digit(s)+letter" value derived from `task.movedAt` — `25s` / `5m` / `7h` / `13d` / `7M` (months) / `3y`, single most-significant unit, ≤2 digits. It re-renders once per second (1s `setInterval`) so the value stays live. Hover shows the full `sidebar.statusChanged` tooltip ("Status changed {relative} · {absolute date}"). No interactivity, no new toolbar control. New pure util `src/mainview/utils/statusAge.ts` (`ageParts`/`compactAge`).
- **Rationale:** This is a `status` indicator, not an action, so it consumes no `task_card` action budget and matches the placement rule that allows "a single status badge" inline. `movedAt` is written only on real status changes (`data.ts`), so it faithfully means "time in current status". Meta-row right alignment keeps the title row and agent row uncluttered. Compact-only on the card (the verbose/absolute form lives in the tooltip) per the user's "100% compact, two-char" requirement.
- **Status:** `Observed` (implemented: `statusAge.ts`, `ActiveTasksSidebar.tsx`; keys `sidebar.statusChanged` + `activity.{seconds,months,years}Ago` in en/ru/es; tip `status-age-badge`).
