# UX Decisions

Append-only log of UX architecture decisions. Each entry: date, decision, rationale, evidence/status.

## 2026-06-19 — Keyboard-shortcut registry as single source of truth + a unified two-tab reference overlay

- **Decision:** Establish `src/mainview/keymap.ts` as the **single source of truth** for every
  app-level keyboard shortcut (declared as data: `id`, per-platform `keys`, `descKey`, `category`).
  The in-app reference is **one** `KeyboardShortcutsModal` (Modal surface, mirroring
  `TmuxCheatSheetModal`'s shell) with **two tabs — App | Terminal (tmux)**: the App tab renders from
  `keymap.ts`; the Terminal tab folds in the existing tmux cheat-sheet content. Entry points:
  (1) native **Help → Keyboard Shortcuts** — wires the currently **dead** `help-keyboard-shortcuts`
  menu action through `menuRouter` (Help → Tmux Cheat Sheet opens the same modal on the Terminal tab);
  (2) keyboard **⌘/ (Ctrl+/ on Linux)**, owned by the `App.tsx` keydown handler in capture phase
  like the palettes, label shows `(⌘/)`; (3) the **⇧⌘P command palette** via a `commands.ts` entry.
  **No** toolbar/header/breadcrumb button. The same registry data also drives the README table and
  the website (`docs/index.html`) section — the legitimate standalone "page" form.
- **Registry is documentation + test, NOT a dispatcher (chosen):** the giant `App.tsx`
  `useGlobalShortcut` if-else stays the executor; refactoring it into a registry-driven dispatch was
  rejected as a risky rewrite of central, edge-case-heavy code (capture phase, terminal focus, zoom,
  `e.code` vs `e.key`). A vitest test guards drift (every spec valid + unique; best-effort flag of
  App.tsx handlers missing from the registry).
- **Placement rationale:** the overlay is `onboarding/help` + `expert_shortcut`, the same class as
  the tmux cheat sheet — it belongs in the Help menu + a keyboard chord + the palette, never on a
  toolbar (toolbar-button-creep is the #1 anti-pattern) and never as a navigation destination
  (ephemeral reference ≠ a place; the nav budget is ≤7). One modal with tabs (vs two sibling modals)
  per the user's "единый вид" requirement; the tab split keeps ~40 tmux bindings from drowning ~25
  app shortcuts. `⌘/` over bare `?`: the live terminal must still receive a bare `?`.
- **Scope:** Follow-up implementation — `keymap.ts`, `KeyboardShortcutsModal` (App + Terminal tabs),
  ⌘/ handler, `menuRouter` `help-keyboard-shortcuts` case, `commands.ts` palette entry, menu label,
  i18n en/ru/es, tests, plus `AGENTS.md`/README/website + the CLAUDE.md registry rule. The
  `keyboard-shortcuts` tip already exists (`tips.ts`).
- **Status:** `Proposed` (design locked via interview 2026-06-19; not yet implemented). `/ux-principal`
  consulted (manifest read; placement/source-of-truth/entry points decided before coding). See
  `feature-plans/keyboard-shortcuts-registry.md`.

## 2026-06-19 — Both palettes surfaced in the native View menu (discoverability)

- **Decision:** Added `Go to Project… (⌘K)` and `Command Palette… (⇧⌘P)` to the **top of the View menu** (`src/bun/application-menu.ts`), grouped above Show Dashboard with a separator. Clicking routes through `handleMenuAction` → a `menu:open-*` CustomEvent → `App.tsx`, which **opens** (not toggles) the palette. The native menu is the canonical action surface (2026-05-29), so the keyboard-only palettes belong there even though they intentionally have no DOM/toolbar button.
- **No native accelerator:** Electrobun menu accelerators are single-character only — chords like `Shift+P` can't be bound (decision 044). The palettes also *toggle* via their `App.tsx` keydown handlers, so a native Cmd+K accelerator would double-fire or block close-toggle. The keydown handlers stay the sole shortcut owners; the chord is shown in the label text instead (the menu renders on macOS only).
- **Status:** `Observed` (implemented: `application-menu.ts` View items, `menuRouter.ts` `open-project-switch`/`open-command-palette` cases, `App.tsx` listeners, decision record 074). `/ux-principal` consulted (manifest read; placement/accelerator decided before coding).

## 2026-06-18 — Action palette (Cmd+Shift+P) added; navigation-vs-action split resolved as two-surfaces-one-shell

- **Decision:** Added the **action palette** (`Cmd/Ctrl+Shift+P`), the action counterpart to the Cmd+K navigation palette promised in the entry below. Resolves the open question (one-palette-with-modes vs. two-surfaces) as **two surfaces on one shared shell**: extracted `PaletteShell` (portal, fuzzy input, keyboard nav, highlight) from `ProjectQuickSwitchModal`; both palettes now render on it. The action palette fuzzy-matches command **labels** and on Enter runs the command via the existing `handleMenuAction` router — so it is a **DOM mirror of the native application menu, not a second command runner**. Commands live in `src/mainview/commands.ts` (id = `handleMenuAction` action string, labelKey, category, scope). Only commands runnable in the current route are listed (`scope: always | project | task`).
- **Hotkey — Cmd/Ctrl+Shift+P:** VSCode's command-palette convention; free here (Cmd+P is Add Project, Cmd+Shift+N is New Window). Pairs naturally with Cmd+K (navigation) so the two intents map to two well-known chords.
- **Excluded by policy (NOT curation):** destructive lifecycle (task delete / cancel / complete) and modal/inline flows (rename, set-overview, add-note, spawn-variants, duplicate) are **deliberately absent** from the quick palette. Manifest rule: destructive needs friction (confirm + placement), not a fuzzy-Enter; modal flows belong to their owning surfaces (inspector, context menu, native menu). They can still be reached there. This is a UX-canon exclusion, not a scope shortcut.
- **Bonus:** routing through `handleMenuAction` also wired several native-menu items that were previously no-op in the renderer (open-new-task, open-add-project, open-settings, task lifecycle moves, toggle-watch, and the home/project terminal entries — which dispatched a CustomEvent nobody listened to; now they navigate directly).
- **Language-switch labels are identical across all locales** (`command.localeEn/Ru/Es` show the target language in its own name, e.g. "Language: Русский (Russian)"). Reason: if the UI is in a language you can't read, a *translated* "switch to English" label is unfindable — the label must stay constant so English is always reachable. Do not "translate" these keys. Also added back/forward navigation commands, and the terminal commands open (not toggle) since open is the palette intent.
- **Scope:** This PR — `PaletteShell` extraction, `CommandPaletteModal`, `commands.ts` registry, Cmd+Shift+P handler, `handleMenuAction` extensions, i18n (en/ru/es), tip, tests, these doc updates + decision record 072. Follow-up — tasks in the Cmd+K palette (via fuzzyMatch); more action commands as needed.
- **Status:** `Observed` (implemented). `/ux-principal` consulted this time (manifest read + placement/scope decided against it before coding).

## 2026-06-18 — Command palette (Cmd+K) introduced as a new surface; entry point for future navigation + commands

- **Decision:** Added a `command_palette` surface — a keyboard-summoned, transient overlay for **type-to-find navigation**. v1 ships **project quick-switch**: press **Cmd/Ctrl+K**, type part of a project name, fuzzy-matched results rank by relevance (`src/mainview/utils/fuzzyMatch.ts`), **Enter** jumps to the best match, **↑/↓** pick another, **Esc**/click-outside cancels. Component `ProjectQuickSwitchModal`, modeled on `TaskSwitcherOverlay` (in-app React portal, no native dialog). Navigation reuses the shared `navigateToProject()` helper, so the palette and `Cmd+1..9` preserve view-mode identically. Keyboard-only: **no** toolbar/breadcrumb button. The palette is explicitly framed as the **entry point of a larger surface**, not just project switching — over time it absorbs navigation (Cmd+K) and gains an action sibling (Cmd+Shift+P).
- **Hotkey — Cmd/Ctrl+K, NOT Cmd+T:** The original implementation used `Cmd+T`. Rejected: `Cmd+T` is the universal "new tab" across browsers and terminals, and dev-3.0 runs a live terminal (ghostty/tmux) under the UI that intercepts it — a constant muscle-memory and key-capture conflict. `Cmd+K` is free here and is the cross-industry convention (Slack/Linear/Notion/Vercel) for "go to anything / switcher", which is exactly this surface.
- **Future vision (locked direction, two surfaces):**
  - **Cmd+K** = quick-switch / navigation — grows from projects to **projects + tasks** (fuzzy). When tasks land, they **must reuse `utils/fuzzyMatch.ts`** — it is the single matcher for short UI entities. BM25 in `src/shared/conversation-search-core.ts` stays for long transcripts only; do not introduce a second short-entity matcher.
  - **Cmd+Shift+P** = command palette for **actions** (create task, git, dev-server, …) — the action counterpart to the navigation palette.
  - Keep navigation vs. action-running cleanly separated (see `ux-architecture.yaml` open_questions): decide one-palette-with-modes vs. two-surfaces before scope grows.
- **Rationale:** Distinct from the `task_switcher` (Option+Tab), which hold-cycles only *active tasks* via MRU — the palette type-searches *all* entities by name. A net-new keyboard-only navigation surface does not trigger toolbar-button-creep (the project's #1 anti-pattern) because it adds no visible chrome. Documenting it now (surface + decision) prevents it drifting off-manifest as it absorbs tasks and commands.
- **Scope:** This PR — the surface, project quick-switch, and the `Cmd+T → Cmd+K` rebind + these UX-doc entries. Follow-up — tasks in the palette (via `fuzzyMatch`) and the `Cmd+Shift+P` action palette.
- **Status:** `Observed` (implemented: `App.tsx` Cmd+K handler + `navigateToProject()`, `ProjectQuickSwitchModal.tsx`, `utils/fuzzyMatch.ts`, i18n `projectSwitch.*`, tip `project-quick-switch`). `/ux-principal` not run (skill not installed in the implementing environment); entries authored by hand against the existing manifest format.

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

## 2026-06-16 — Browser-style back/forward navigation in the global header

- **Decision:** Add two icon-only navigation arrows pinned at the **far left of the `GlobalHeader` breadcrumb row** (before the `dev-3.0` segment), plus the keyboard shortcuts `⌘[` (back) / `⌘]` (forward) and mouse side buttons (button 3 = back, button 4 = forward). They drive the route-history stack that already existed in `state.ts` (`routeHistory`/`historyIndex`/`goBack`/`goForward`, `HISTORY_LIMIT=15`) — previously only the Changelog screen consumed it. The two chevron-left/right Nerd Font glyphs are wrapped in a **segmented pill** (Safari-toolbar style): one `rounded-md border-edge bg-raised` container with a 1px `bg-edge` hairline divider between the buttons. Each button is role `neutral`/`ghost` (`text-fg-3 hover:text-fg hover:bg-elevated`) and disables (`text-fg-muted/40 cursor-default`) when `canGoBack`/`canGoForward` is false. Glyph is `text-sm` (14px), matched to the breadcrumb's 14px location icon (not the 18px right-cluster action scale). Rationale for the container: bare chevrons at the top-left corner did not read as navigation (looked decorative / drag-like) and visually merged into one symbol — the bordered segmented group is the universal "this is a back/forward control" affordance and the divider separates the two arrows. Icon-only (no "Back"/"Forward" text labels): the chevron pair is the universal browser convention, the tooltip carries the shortcut hint, and labels would consume scarce horizontal space.
- **Rationale:** Navigation history is not an action — it belongs next to the breadcrumb "address bar", matching the universal browser mental model the user asked for ("туда-сюда бегать"). The far-left of the header was empty, so this adds zero pressure to the already-dense right-hand action cluster (governed by the compact-overflow budget). Reusing the existing history reducer means no new state and no behavior risk. A long history dropdown was rejected as scope-creep — back/forward only.
- **Status:** `Observed` (implemented: `GlobalHeader.tsx` nav buttons, `App.tsx` `⌘[`/`⌘]` shortcut + `mouseup` side-button handler + prop wiring, `state.ts` reducer reused; keys `header.navBack`/`header.navForward` in en/ru/es; tip `back-forward-nav`).

## 2026-06-19 — Diff review is durable (persisted) + explicit "Reset review"; document the diff viewer surface

- **Decision:** The inline diff-review in `TaskDiffViewer` is made **durable**: inline comments persist per task in `localStorage` and survive unmount, diff reload, and app restart. The clipboard becomes pure *transport*, not the store. A new **`Reset review`** control is added to the Review-export card (left Files aside), placed **below** the existing full-width `Copy review` primary. `Reset review` is role `destructive`, low-emphasis ghost-danger styling (`text-danger` + `border-danger/30` + `hover:bg-danger/10`), visible only when ≥ 1 comment exists, and gated behind a `confirm()` dialog (React confirm service — no native dialog). The review is cleared **only** by Reset (or, optionally, a successful copy). Consequence: leaving the surface no longer discards anything, so the old "discard review?" confirm-on-close guard is dropped/softened. As part of this, the previously-undocumented **diff review viewer** surface was added to the manifest (Bible §5.2 + `ux-architecture.yaml: surfaces.diff_review_viewer`).
- **Rationale:** The fatal failure was that the review lived only in volatile clipboard + in-memory React state (`inlineComments` useState, wiped on reload/unmount); an accidental terminal text-selection clobbered the clipboard and the whole review (often 10+ comments over a 1000-line diff) was lost irrecoverably. Persistence is the cheap durability guarantee; an explicit Reset is the only deliberate clear. Reset is destructive (matches the taxonomy's "reset terminal / hard refresh" precedent) so it must never wear primary/accent — that would compete with Copy and invite an accidental data-loss click. No new destination, no inspector toolbar-creep: the whole review lifecycle stays inside the diff viewer.
- **Status:** `Proposed` (plan: `docs/ux/feature-plans/persist-diff-review.md`; implementation pending in `TaskDiffViewer.tsx` + i18n `infoPanel` keys + tests + changelog + 1 tip).
