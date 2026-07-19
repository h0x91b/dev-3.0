# Product UX Bible — dev-3.0

Status: Draft (initial)
Source: Derived from repository audit
Last updated: 2026-07-19
Owner: Product UX Architecture

Evidence notation: `Observed` (backed by code/docs), `Inferred` (likely rule from repeated patterns), `Proposed` (recommended, not yet consistent), `Unknown` (insufficient evidence).

## 1. Purpose

Canonical UX architecture reference for dev-3.0. It defines how the app organizes navigation, screens, surfaces, actions, and design-token roles, and where new features should live. Agents must consult this (via the `ux-principal` skill) before adding UI.

### 1.0 North-star principle — the user is the star; optimize for the lazy human — `Observed`

**When a default, shape, or amount-of-typing trades off the human's effort against a machine's, always favor the human.** The user is a person — lazy by design, and rightly so: they should type/click the minimum and get the obvious, most-wanted outcome. Agents, scripts, CI, and supervisors are not — they can happily emit a longer command with explicit flags, read a man page, or carry extra config. So:

- **Defaults serve the human's most common intent**, even if that diverges from a machine-world convention. Example: `dev3 remote` (a hand-typed command) **backgrounds by default** because "start it and give me my shell back" is what a person wants — Docker/nginx default to foreground, but a human typing the command is not Docker. The foreground/supervised path is the one that pays the extra `--no-detach` flag, because the thing that needs it (systemd, a Docker `CMD`, a script) is a machine and doesn't mind the verbosity. See `UX_DECISIONS.md` (2026-06-28, detach-by-default).
- **Push required verbosity onto the non-human caller**, never onto the person. If exactly one side must say more, make it the agent/script/supervisor.
- This applies to CLI defaults, flag polarity (prefer `--no-x` opt-outs over `--x` opt-ins when the human wants `x` by default), prefilled form values, smart defaults in dialogs, and "do the obvious thing on Enter."
- It does **not** mean hiding power or breaking safety: destructive/irreversible actions still demand explicit confirmation (the human's effort there is the point). It means the *happy, safe, common* path is the lazy path.

Litmus test when choosing a default or flag polarity: *"who is typing this, and what do they most want with the fewest keystrokes?"* If the answer is "a human, who wants X" — make X the default and let machines opt out.

### 1.1 Instrument & celebrate — countable progress feeds the Velocity Cockpit — `Proposed`

**dev-3.0 ships a surface whose entire job is to make shipping *feel* rewarding — the read-only Productivity Stats / Velocity Cockpit (`stats`).** People love a number that ticks up; the cockpit is where the product turns raw activity into motivation. Treat it as a first-class consumer of every new feature, not an afterthought.

- **Instrument by default.** When a feature produces a *countable, repeatable* signal (a thing shipped, a run completed, a streak, a volume, a milestone crossed), emit that signal into the stats pipeline **at build time** — extend the `getProductivityStats` event shape (`src/bun/rpc-handlers/productivity-stats.ts`) and/or the pure aggregation engine (`src/mainview/utils/productivityStats.ts`) — rather than bolting analytics on months later. The data should *exist* even if you don't draw a chart for it yet.
- **Then surface it — selectively.** If the metric is *motivational* (progress, momentum, achievement, milestone), add a visualization to the cockpit. If it is merely *diagnostic*, keep the data but do **not** clutter the cockpit with it.

**Guardrails — this is not a license to dump every counter onto one screen:**
- The cockpit is **read-only**. Never add a **data filter** (slicing by project/agent/label — a new dimension beyond the time axis), durable config, or any mutation there (`ux-architecture.yaml surfaces.stats_dashboard.forbidden`). It celebrates; it does not operate. **Permitted exception — temporal navigation of the existing time range:** the prev/next period stepper (browse past days/weeks/months) is an *extension of the time-range switch on the same axis*, not a new control class — it stays read-only, its offset is ephemeral (not persisted), and it adds no new data dimension. Time is the one axis the cockpit already governs; navigating along it is allowed, filtering across new ones is not.
- Respect a **complexity + honesty budget**. Prefer one strong motivational signal over five weak ones; consolidate; a new metric must *earn* its place. A wall of near-zero gauges is worse than no gauge.
- **Forward-only honesty.** If a signal only starts being recorded now, show an honest "tracking since" / empty-state treatment (as the LOC views do) — never backfill fake history or imply data you don't have.
- **Motivational ≠ vanity-at-any-cost.** The number must be *true*. Don't inflate or double-count to look impressive — a dishonest cockpit destroys the trust that makes it motivating.

Litmus test when shipping a feature: *"does this produce something countable a developer would be proud to watch tick up?"* If yes — emit the data now, and surface it on the cockpit when it motivates. See §5 (Productivity Stats surface), §9 (budgets), §10 (placement rules), and `UX_DECISIONS.md` (2026-06-29).

## 2. Product overview

### Product type — `Observed`

- **App type:** Full-screen desktop web app. Electrobun shell (Bun main process) renders a React 19 + Tailwind + Vite webview. Not Electron, not a website.
- **Primary users:** Developers running multiple AI coding agents (Claude Code, Codex, Gemini CLI, Cursor) across many tasks; terminal-centric power users.
- **Primary jobs:** create a task → get an isolated git worktree + tmux terminal with a preconfigured agent; track tasks on a Kanban board; run git/PR/dev-server operations per task; manage multiple git-repo projects with lifecycle scripts.
- **Operating mode:** Long-lived window, keyboard-heavy, many concurrent terminals. Density is expected and tolerated by the audience — but not unlimited (see budgets).

Evidence: `concept.md`, `AGENTS.md`, `src/mainview/state.ts`, `src/shared/types.ts`.

### Known gaps

- No URL routing — navigation is a screen-based `Route` union (`src/mainview/state.ts`).
- No formal `<Button variant>` component — buttons are inline-styled with semantic tokens.
- No multi-select / bulk-action model on the board (per-task actions only).
- No dedicated `--info` semantic token (accent/blue is reused).

## 3. Object model — `Observed`

| Object | Route (screen) | Detail | Owner | Common actions | Evidence |
|---|---|---|---|---|---|
| Project | `dashboard` | `project` | workspace | add, clone, open settings, reorder, remove, pull main | `types.ts (Project)`, `Dashboard.tsx`, `ProjectSettings.tsx` |
| Project (kind: virtual) | `dashboard` (badged) | `project` | workspace | add (Operations), open, rename, remove | `types.ts (Project.kind)`, `AddProjectModal.tsx`, `data.ts (addVirtualProject)` |
| Task | `project` (card) | `task` (full terminal) / split in `project` | project | create, move status, rename, set overview, note, spawn variants, add attempts, duplicate, delete, watch, open-in, git, dev-server | `types.ts (Task)`, `TaskCard.tsx`, `TaskInfoPanel.tsx`, `application-menu.ts` |
| Label | — (overlay on tasks) | — | project | create, rename, recolor, assign, filter | `types.ts (Label)`, `LabelPicker.tsx`, `LabelFilterBar.tsx` |
| Custom Column | — (board column) | — | project | create, rename, recolor, set LLM instruction, attach agent | `types.ts (CustomColumn)`, `KanbanBoard.tsx` |
| Note | — (in inspector) | — | task | add, edit, delete | `types.ts (TaskNote)`, `NoteItem.tsx`, `task-info-panel/TaskNotes.tsx` |
| HTML Artifact | — (conditional Runtime-bar entry) | docked/fullscreen task workspace | task | view, resize, fullscreen, navigate history, download HTML/ZIP | `types.ts (SharedArtifact)`, `TaskArtifactViewer.tsx`, `show-artifact.ts` |
| Automation | — (managed in `project-settings` tab `automations`) | — | project | create, edit, enable/disable, run now, view run history, delete | `types.ts (Automation)`, `ProjectSettings.tsx`, `automations-scheduler.ts` |

**Automation (`Observed`, 2026-07-05):** a per-project scheduled agent run — an RFC 5545 RRULE subset + IANA timezone, a stored prompt, and an agent choice. When a schedule fires (bun-process scheduler, runs in desktop **and** `dev3 remote` headless), it creates an **ordinary task** (worktree + tmux + agent, prompt = task description) on the board — automations never grow their own board, destination, or task list. Provenance: the created task records its `automationId` and the card shows a small clock glyph; run history (fired / task created / missed while app was offline) is persisted per automation and shown only inside the Automations tab. Missed runs are surfaced (toast + per-automation status), never silently skipped. A built-in **"What I shipped" report template** pre-fills the create form; the resulting digest is again just a task. CLI: `dev3 automations …`.

Task lifecycle states (`ALL_STATUSES`): `todo`, `in-progress`, `user-questions`, `review-by-ai`, `review-by-user`, `review-by-colleague`, `completed`, `cancelled`. Most transitions are hook-driven, not manual.

**Project kind (`Observed`, 2026-06-23):** `Project.kind` is `git` (default) or `virtual`. A **virtual "Operations" board** is the same Project object class — it reuses the dashboard, board, cards, sidebar, labels, and notes — but its tasks run an agent + a split-right shell in a managed temp folder (or a chosen one) with **no git worktree**; the entire git domain (branch/diff/PR/push/merge/rebase, the inspector Git bar, and all three review columns) is hidden, leaving `todo → in-progress → user-questions → completed/cancelled`. One built-in board ships by default and hosts the **Quick-shell** operation (⇧⌘`), which replaced the former single home terminal. See decision 079 + feature plan.

## 4. Navigation model — `Observed`

The app uses a **screen router** (`Route` union + `useReducer` with a 15-entry back/forward history), not URLs.

### Global navigation

Destinations: `dashboard`, `project` (Kanban — the daily home), `task`, `project-terminal`, `settings`, `project-settings`, `changelog`, `stats` (Productivity Stats / Velocity Cockpit). Debug-only: `gauge-demo`, `viewport-lab`.

Mechanism: `GlobalHeader` breadcrumbs (`Dashboard > Project > Task`) + back/forward + native application-menu `View`.

- **Allowed:** stable destinations, workspaces, major product areas.
- **Forbidden:** one-off actions, filters, temporary state, object-specific controls.
- **Budget:** ≤ 7 top-level destinations, max depth 2. Debug screens stay menu-only.

### Breadcrumbs — `Observed`

Show location only. Text click navigates; the project chevron opens a **project-switcher dropdown**. No commands in breadcrumbs.

Evidence: `GlobalHeader.tsx`.

### Tabs — `Observed`

Only in `project-settings` (`global | project | worktree | automations`). Budget ≤ 6 visible tabs.

### Command palette (Cmd/Ctrl+K nav · Cmd/Ctrl+Shift+P actions) — `Observed`

A keyboard-summoned palette with **two modes on one shared shell** (`PaletteShell`). **Cmd+K** = navigation: fuzzy-jump to a project, Enter navigates (complements `Cmd+1..9` and the breadcrumb dropdown). **Cmd+Shift+P** = actions: fuzzy-match a command label, Enter runs it via `handleMenuAction` — a DOM mirror of the native menu, not a second command runner; only context-applicable commands show. Both fuzzy via `utils/fuzzyMatch.ts`. Destructive (delete/cancel/complete) and modal/inline flows (rename, overview, note, spawn, duplicate) are excluded from the quick palette by policy. See Surface model below.

## 5. Surface model — `Observed` unless noted

| Surface | Purpose | Allowed | Forbidden | Evidence |
|---|---|---|---|---|
| Global header | Location + switching + app utilities | breadcrumb, destination, project switcher, settings/changelog entry, tmux manager, prevent-sleep (awake) toggle | task-scoped action, dense filters, destructive primary | `GlobalHeader.tsx` |
| Application menu (native) | Canonical home for the full action taxonomy | every action type | — | `application-menu.ts`, `menu-actions.ts` |
| Kanban board | Primary work surface | task cards, create-in-column, drag-move, column config, task filter (token-DSL search + funnel; label chips are a view of it) | durable global config | `KanbanBoard.tsx`, `KanbanColumn.tsx`, `LabelFilterBar.tsx`, `FilterFunnel.tsx` |
| Task card | Compact task summary | status dot, labels, variant dots (≤3, clickable → sibling popover), open, context menu, git badge | full settings, global destination, unbounded dot rows | `TaskCard.tsx` (large — watch density) |
| Task info panel (inspector) | Active-task control: git, dev server, scripts, notes, tmux, open-in | object/git/dev-server actions, metadata, notes | global destination, cross-project action | `TaskInfoPanel.tsx` (densest surface) |
| Terminal immersive fullscreen | Ephemeral task-bound terminal workspace for focused tmux work | tmux terminal, existing tmux window/pane controls, `dev3` brand, one wide Exit full screen action | global/app header, task switching UI, inspector controls, route persistence, any tmux pane/layout mutation | `App.tsx`, `TaskInfoPanel.tsx` |
| Diff review viewer | Full-screen read + inline-review of a task's diff | view-mode toggle, file-tree nav, search, mark-read, per-file copy-path, inline comments, review export/copy/reset | task lifecycle action, git mutation, global destination | `TaskDiffViewer.tsx` (see 5.3) |
| Task image viewer | Task-bound lightbox for images an agent surfaced via `dev3 show-image` (history rail, newest first) | image display, history nav (thumbnails + prev/next + arrows), copy image, reveal path, clear (destructive) | global destination, task lifecycle/git mutation, persistent inspector button (badge is conditional), SVG render (v1) | `TaskImageViewer.tsx` (planned; see UX_DECISIONS 2026-07-02) |
| Task artifact workspace | Task-bound interactive HTML surfaced via `dev3 show-artifact`; docked beside the terminal, resizable, fullscreen on demand | sandboxed HTML display, history nav, theme sync, HTML/ZIP download | global destination, task lifecycle/git mutation, parent DOM/RPC access, subresource network access, native dialog (trusted inline scripts can self-navigate their iframe) | `TaskArtifactViewer.tsx`, `TaskWorkspacePane.tsx`, `shared-artifacts.ts` |
| Modal | Focused create/confirm | create flow, confirm, focused config | navigation, persistent dashboard | `*Modal.tsx` |
| Popover | Contextual preview/hint | preview, hint, quick action, remediation | multi-step flow, primary destination | `*Popover.tsx` |
| Context menu | Right-click object actions | object action, open-in, destructive | global destination | `OpenInMenu.tsx` |
| Settings | Durable configuration | configuration, preference, integration, scripts | daily operational action | `GlobalSettings.tsx`, `ProjectSettings.tsx` |
| Sidebar | Active-task jump list (readiness-tier work queue: NEEDS YOU = Your Review, Has Questions, PR Review → custom columns → WAITING = Agent is Working, AI Review; priority-sorted, visible `P{n}` badge) | destination, task jump, priority re-order (badge picker), terminal preview, search + token-DSL task filter (funnel, active-statuses pool), variant dots (≤3, clickable → sibling popover, bottom row) | durable config | `ActiveTasksSidebar.tsx`, `sidebarTiers.ts`, `FilterFunnel.tsx` |
| Command palette (Cmd+K nav / Cmd+Shift+P actions) | Type-to-find nav + type-to-run commands (two modes, one shell) | destination, fuzzy search, object jump, command runner (action mode, via handleMenuAction) | destructive action, modal/inline flow, durable config without friction, dense filters | `PaletteShell.tsx`, `ProjectQuickSwitchModal.tsx`, `CommandPaletteModal.tsx`, `commands.ts` |
| Keyboard-shortcuts overlay | Read-only keymap reference (App + Terminal tabs) | grouped shortcut rows, tab switch | action runner, durable config, nav destination | `KeyboardShortcutsModal` (planned), `TmuxCheatSheetModal.tsx`, `keymap.ts` (planned) |
| Hint navigation overlay | Keyboard-only jump-to-target (Vimium-style) | per-target letter badge over any `[data-hint-id]` (task card, project row, sidebar task), type-to-jump | mutation/destructive target, visible chrome, durable config | `HintOverlay.tsx`, `utils/hintLabels.ts` |
| Toast | Transient feedback | status, error | persistent/primary action | `ErrorToast.tsx` |
| Diagnostics (crash + error surface) | Make renderer faults visible in remote/mobile where there is no devtools | crash fallback (error boundary), bootstrap phase + timeout→retry, captured error list, copy/clear, conditional floating entry | navigation destination, mutation of app data, permanent chrome in the happy path | `RootErrorBoundary.tsx`, `BootstrapScreen.tsx`, `DiagnosticsPanel.tsx`, `DiagnosticsIndicator.tsx`, `diagnostics.ts` (see §5.5) |
| Inline help (Tooltip / HelpSpot → HelpCard / help mode) | Explain what a section is, why it exists, what to do in it | fast control tooltip, section (i) in header-bearing surfaces, rich read-only HelpCard, screen-wide help-mode overlay | mutation, multi-step tour, permanent (i) in quickbars/cards/toolbars | `Tooltip.tsx`, `HelpSpot.tsx`, `HelpCard.tsx`, `HelpOverlay.tsx`, `help.ts` (see §5.4) |
| Productivity Stats (Velocity Cockpit) | Read-only showcase of shipping output over time | hero speedometer gauges, SVG bar/area charts, per-project gauge wall, counters, time-range switch + prev/next period navigation, per-project→board jump | mutation, lifecycle/config action, header button, data filter (new dimension beyond time) | `ProductivityStatsView.tsx`, `components/stats/*` |

Note: native menu is the **overflow/expert** surface; frequent actions are mirrored into DOM toolbars (inspector, board).

The **command palette** is keyboard-only by design (no toolbar/breadcrumb button → sidesteps button-creep) and runs in two sibling modes on one shared `PaletteShell`. **Navigation (Cmd+K):** fuzzy-jumps to a **project**; the matcher (`utils/fuzzyMatch.ts`) is the single matcher for short UI entities. **Actions (Cmd+Shift+P):** fuzzy-runs a command via `handleMenuAction` (DOM mirror of the native menu), listing only context-applicable commands and excluding destructive + modal/inline flows by policy. It is **not** the task switcher: the switcher (Option+Tab) hold-cycles the *active tasks*; the palette type-searches. Hotkeys avoid `Cmd+T` (universal new-tab; the live terminal underneath intercepts it). The navigation-vs-action question is resolved as **two-surfaces-one-shell** — see `UX_DECISIONS.md` (2026-06-18) and decision record 072. **Future:** Cmd+K absorbs task search too.

### 5.1 Task info panel — bar model (2×2) — `Observed`

The inspector header (`TaskInfoPanel.tsx`, both collapsed and expanded states) is a **2×2 grid of quickbars**: two rows, each split into a left and a right bar by a `flex-1` spacer. This exploits the wide desktop width instead of stacking more rows above the terminal (the panel has a hard height budget, `MAX_RATIO = 0.33`). **Each bar owns exactly one action domain. Panel chrome is not a bar.**

| Bar | Position | Domain | Contents | Evidence |
|---|---|---|---|---|
| Context | row 1, left | task identity & lifecycle | variant switcher (conditional, leading), watch toggle, status dropdown, diff-summary badge, include-tests toggle, label strip | `TaskInfoPanel.tsx` (row 1 left cluster) |
| Session/Agent | row 1, right | drive the session & agents | spawn extra agent, bug hunters, tmux controls, send message later (scheduled agent message) | `TaskInfoPanel.tsx` (row 1 right cluster), `TaskTmuxControls.tsx` |
| Git | row 2, left | branch & PR | branch name/status, show diff, refresh, copy worktree path, open PR | `task-info-panel/TaskGitActions.tsx` |
| Runtime & access | row 2, right | project runtime outputs + access to them | open-in, scripts, dev server, ports, separate conditional Images and Artifacts controls (count>0 only); ports/resources also render as detail in the expanded body | `task-info-panel/TaskOpenIn.tsx`, `TaskSharedImages.tsx`, `TaskArtifacts.tsx` |

Rules:

- **Row 1 = "Drive"** (what the task is + how I control its session). **Row 2 = "Outputs"** (what the work produces and how I access it: branch/PR + open-in/scripts/running server). open-in lives here because it opens the produced worktree, and it keeps the Runtime bar balanced (3 controls) instead of leaving it sparse.
- **Chrome** (collapse/expand, fullscreen toggle, ⚙ worktree-settings) is pinned to the far right edge of row 1 and is **not** counted as a bar or against any bar's budget.
- A new control must be assigned to exactly one domain and placed in that bar. Do not drop it into whichever bar has room — that is how the pre-2026-06 "everything in row-1-right" dumpster happened.
- **Label overflow:** the Context bar shows up to `MAX_INLINE_LABELS` (4) chips inline, then a `+k` chip (hover lists the rest). The full label list still renders in the expanded metadata grid, so the inline strip may truncate safely.
- **Variant switcher (conditional):** when the task's variant group has ≥ 2 **alive** (active-status) variants, the Context bar leads with a compact segmented switcher — one numbered chip per alive variant (status-colored, current highlighted); click switches the workspace to that sibling. It counts as **one composite control** (like the label strip) and is an explicit conditional exception to the four-control budget; no unrelated control inherits the exception. Keyboard: `⇧⌘[` / `⇧⌘]` cycles alive variants (registered in `keymap.ts`).
- Per-bar visible-action budget stays at the toolbar default (≤ 4 visible, then overflow). **Explicit exception:** the Runtime bar may additionally show separate `Images` and `Artifacts` controls when those outputs exist; both are conditional, user-selected identities rather than permanent chrome. Do not use this exception for unrelated controls.

### 5.2 Keyboard-shortcut registry + reference overlay — `Proposed`

Keyboard shortcuts are the app's primary interaction model, so they get a **single source of truth**:
`src/mainview/keymap.ts` declares every **app-level** shortcut as data (`id`, per-platform `keys`,
`descKey`, `category`). This registry **documents**; it does not drive dispatch — the `App.tsx`
`useGlobalShortcut` if-else stays the executor (refactoring it was rejected as a risky rewrite of
edge-case-heavy code), with a vitest test guarding drift.

The user-facing reference is **one** `KeyboardShortcutsModal` (Modal surface, same shell as
`TmuxCheatSheetModal`) with two tabs — **App** (renders from `keymap.ts`) and **Terminal (tmux)**
(the folded-in tmux cheat sheet). It is `onboarding/help` + `expert_shortcut` content, reached only
via **Help → Keyboard Shortcuts**, the **⌘/ (Ctrl+/)** chord, and the **⇧⌘P** palette — never a
toolbar/header button (toolbar-button-creep) and never a navigation destination (ephemeral reference
≠ a place). The same `keymap.ts` data renders the README table and the website
(`docs/index.html`) section. Adding a new app-level shortcut **must** add a `keymap.ts` entry.

See `UX_DECISIONS.md` (2026-06-19).

### 5.3 Diff review viewer — `Observed`

Full-screen surface (`TaskDiffViewer.tsx`) reached from the inspector `show_diff` action / `diff_summary_badge`. It is a **read + review** surface: it renders a task's diff and lets the user attach inline comments, then export them as an XML review prompt for the agent. It performs **no git mutation and no task-lifecycle action** — those stay in the inspector and native menu.

Layout = left **Files aside** (collapsible, `22rem`) + right **diff stream**.

- **Top toolbar (right of file tree):** diff-mode segmented control (`uncommitted | branch | unpushed | recent`, mode persisted), view-mode toggle (`split | unified`), include-tests toggle, search (`Cmd+F`, in-diff find with next/prev + highlight), close/back (`Esc`). The `recent` ("Recent commits") segment is a **split-button**: the body activates `HEAD~N..HEAD` (committed-only, clamped to the branch's own commits) at the current N; a `▾` caret opens a preset popover (1/2/3/5/10). N is **not** persisted — it resets to 1 on every diff open — while the mode selection follows the same localStorage preference as the other three. Body label reflects the selected N; the header sub-label reflects the *effective* (clamped) count honestly.
- **Files aside** contains two cards: the **Review export card** (top) and the **Files card** (read-progress + expand/collapse-all + the file tree).
- **Per-file header (diff stream):** status chip (A/M/D/R/C/T/?), path (click = expand/collapse), **copy-file-path** icon button (role `neutral`/icon), `+N/−N` stat pill, **mark-read** checkbox (success-tinted when read), expand/collapse caret.
- **Inline comments:** drag across the gutter to select a line range (or use the hover `+` widget for a single line) → composer opens → comment is added to a per-file/per-side/per-line thread. Threads render inline and are editable/deletable in place.

**Review export card — action hierarchy (the one budgeted cluster):**

| Control | Role | Token | Visibility |
|---|---|---|---|
| Copy review | `primary` (the single primary here) | `bg-accent` solid, success-tint on copied | always (disabled when 0 comments) |
| Reset review | `destructive`, low-emphasis | ghost-danger: `text-danger` + `border-danger/30` + `hover:bg-danger/10` | only when ≥ 1 comment; confirmation required |
| Comment count | `status` | `bg-raised` mono badge | always |
| Comment item | `link`-like (scroll-to) | `bg-raised/65`, accent on hover | per comment |

**GitHub PR review layer (read-only) — `Observed` (2026-07-19):** when the task has an associated PR, the viewer renders GitHub review threads inline on their anchored lines (same widget/extend mechanism as local comments, visually distinct: GitHub glyph, author login, timestamp, markdown body) plus a collapsible **"Conversation (N)"** strip at the top of the diff stream listing top-level PR comments. That strip is the layer's one control cluster (collapse, show-resolved toggle, refresh, fetched-at, PR link) — never toolbar buttons. Unresolved threads expand by default; resolved hide behind the toggle; threads that no longer map onto the rendered diff collapse into a per-file "Outdated" group (threads on files absent from the diff group inside the conversation block) — nothing is silently dropped. Inline anchoring is **branch-mode only**; other modes show a slim "N review threads → Branch diff" hint. Per-thread actions: `Send to agent` (role `secondary` — pushes a fix prompt into the task terminal; the surface primary stays Copy review), `Open on GitHub` (role `link`), `Include in export` (opt-in into the XML export; exported entries carry an origin marker). **Hard rule: no writes to GitHub from this surface — no reply, no resolve, no authoring; links out instead.** Data comes from one cached on-demand RPC (gh GraphQL) fetched on diff open / manual refresh; badge counts stay on the background PR poller.

Rules specific to this surface:
- **One primary only** — `Copy review` owns it. `Reset review` is destructive and must never carry primary/accent fill (would compete and risk an accidental data-loss click). It sits below Copy, lower-emphasis, gated behind a `confirm()` dialog.
- **The inline review is a short-lived safety net, not clipboard-only or permanent.** Comments persist per task (`localStorage`) and survive unmount / diff reload / app restart, but only for a **3-day TTL** measured from when the review was first created — after that they auto-expire on next read. The clipboard is a *transport*, not the store: if a stray terminal selection clobbers the copied review, reopen the diff and copy again. The review is cleared by the **Reset review** button or by TTL expiry. A **global sweep** on every diff-viewer mount prunes expired/corrupt review keys across all tasks, so entries for never-reopened or deleted tasks cannot accumulate in `localStorage`. Leaving the surface does **not** discard it — so no "discard review?" guard on close.
- No new top-level destination, no toolbar-creep into the inspector: the whole review lifecycle lives inside this surface.

### 5.4 Inline help system — Tooltip / HelpSpot / help mode — `Observed`

**Problem.** The app explains itself through ~227 native `title=` attributes: slow (OS hover delay), unstyled, control-scoped — they can name a button but never explain a *section* ("what is this toolbar, why does it exist, what do I do here"). No shared Tooltip primitive exists; each custom popover re-implements positioning.

**One registry, three layers:**

1. **`Tooltip`** — a fast styled popover primitive (portal, shared positioning util, ~250 ms hover-intent, instant re-show grace) that progressively replaces native `title=` on icon-only controls. Control-level: *what does this button do*. Migration is incremental — densest surfaces first (inspector bars, GlobalHeader, TaskCard).
2. **`HelpSpot` → `HelpCard`** — a small ghost **(i)** icon allowed **only** in surfaces that already have a header/title row (SettingsSection headings, modal headers, Kanban column headers, diff-viewer toolbar, stats section titles). Hover (intent) or click (pins) opens a **HelpCard**: topic title, 2–4 sentence body, optional "what you can do here" bullets, optional shortcut chips (crosslinked to `keymap.ts` ids), optional nav link (e.g. "Open Keyboard Shortcuts"). Budget: **≤ 1 HelpSpot per section header**; icon role `ghost`, hover emphasis reuses `accent` (no new `--info` token).
3. **Help mode** — a screen-wide "Explain this screen" overlay. Entry points: Help menu, `⇧⌘/`, `⇧⌘P` palette entry, header kebab (narrow/touch — the native menu is absent in remote). Every registered zone (tagged `data-help-id`, mirroring the hint overlay's `data-hint-id`) gets an (i) badge + outline; hover/click any zone opens the same HelpCard; `Esc` exits. This is how dense, headerless zones (inspector quickbars, task card, active-tasks strip) get help **with zero permanent chrome**.

**Registry:** `src/mainview/help.ts` (`HELP_TOPICS`: id, titleKey, bodyKey, optional bullets/shortcutIds/link) — the same declare-as-data pattern as `keymap.ts` and `tips.ts`; content localized in an `help.ts` i18n domain (en/ru/es). Help copy is never hardcoded in components. Topics may crosslink tips (`tip.*`) instead of duplicating text.

**Hard rules:**
- A permanent (i) never sits inside quickbars, task cards, or action toolbars — those zones are covered by help mode only (creep protection; see §11).
- HelpCard is **read-only**: navigation links allowed, mutations forbidden; no multi-step tours in v1.
- HelpCard clamps to the viewport (`max-w-[calc(100vw-2rem)]`), honours `prefers-reduced-motion`, is keyboard-reachable (HelpSpot is a focusable button, `Enter` pins, `Esc` closes) and announced via `aria-describedby`/`role="dialog"` when pinned.

### 5.5 Diagnostics — crash & error surface (remote/mobile) — `Observed`

**Problem.** In browser remote mode — especially on a phone with no devtools — a renderer fault is invisible: a React crash unmounts the tree to a blank page, a stuck bootstrap spins a bare "Loading…" (up to the 120s RPC timeout), and `window.onerror`/`unhandledrejection`/WebSocket failures go only to console/GA4/a backend file the user can't see. The user can neither see nor report what broke.

**One store, three surfaces (+ a pre-React loader):**

1. **`diagnostics.ts`** — a framework-agnostic ring buffer (cap 50, deduped) fed by `window.onerror`, `unhandledrejection`, the React boundary, and RPC/WS transport failures/connection-state changes. No React import, so the crash fallback can read it even when the provider tree is unmounted.
2. **`RootErrorBoundary`** — wraps the providers **and** `App` in `main.tsx` (so a provider crash is still caught). Self-contained English fallback (a **documented i18n exception** — the translation provider may be what threw) with the message, recent diagnostics, and Reload / Copy details.
3. **`BootstrapScreen`** — replaces the two bare loading spinners: names the phase (connecting / authenticating / loading) and, after a ~12s stuck timeout, flips to an actionable panel (likely cause + last captured error + Retry/Reload).
4. **`DiagnosticsPanel` + `DiagnosticsIndicator`** — the full viewer (copy/clear, viewport-clamped for phones) opened from a **conditional** floating pill that renders **only in remote mode and only when `errorCount > 0`** — zero chrome on the happy path (no button-creep), absent in the Electrobun desktop shell (which has devtools + "Open logs"). Plus a static pre-React loader in `index.html` (inside `#root`, replaced on mount) so a failed bundle shows a hint + Reload instead of a blank flash.

**Hard rules:** the crash fallback and pre-React loader use inline/neutral styling and no providers (they must survive a broken theme/i18n). The diagnostics entry point is earned, not permanent — never a toolbar/header button, never a nav destination. All surfaces are pure React (no native dialog). See `UX_DECISIONS.md` (2026-07-10).

## 6. Action taxonomy — `Observed`

| Action type | Definition | Placement | Token role |
|---|---|---|---|
| primary_action | Main safe action for screen/flow (Create Task, Add Project, Save) | modal footer / page header | primary (`bg-accent`), max 1 visible |
| object_action | Acts on one task/project (rename, overview, watch, duplicate, open-in) | inspector, card context menu, menu `Task` | secondary / ghost |
| git_action | pull, push, create PR, merge, rebase, branch status | inspector `TaskGitActions`, menu `Project`, board git-pull | secondary; runs in visible terminal (decision 008) |
| dev_server_action | start / stop / restart / status | inspector `TaskDevServer`, menu `Project.DevServer` | neutral; risky variants flagged |
| lifecycle_action | move task status, complete, cancel (mostly hook-driven) | board drag, status dropdown, menu `Task.MoveToStatus` | status-colored |
| configuration | durable behavior change (scripts, columns, labels, theme, locale, gh account) | settings, project settings | secondary |
| destructive | delete task, remove project, cancel, reset terminal, hard refresh | overflow, context menu, confirm dialog, danger zone | destructive (`text-danger`/`bg-danger`), confirmation required |
| expert_shortcut | rare known action (debug screens, tmux cheat sheet, zoom, gauge/viewport lab) | menu `View`/`Debug`, keyboard | neutral |
| onboarding_help | explains a surface/section (help topics, tips, shortcuts reference) | HelpSpot in section headers, help-mode overlay, menu `Help`, TipCard | ghost icon; accent reused for informational emphasis |

## 7. Design token & variant policy — `Observed`

Tokens are CSS custom properties in `src/mainview/index.css`, mapped to Tailwind in `tailwind.config.js`, with `dark` (default) and `light` themes. **Never hardcode hex/rgb in components** (AGENTS.md). There is **no `variant=` prop** — document semantic role → token class.

### Button roles

| Semantic role | Token class | Use for | Do not use for |
|---|---|---|---|
| primary | `bg-accent` / `hover:bg-accent-hover` (white text) | the one main safe action | competing CTAs, destructive actions |
| secondary | `bg-raised`/`bg-elevated` + `border-edge`, or `text-accent bg-accent/10` | supporting visible action | the irreversible main action |
| ghost | transparent + `hover:bg-raised-hover`/`hover:bg-elevated-hover` | dense-toolbar icon/utility buttons | critical-path primary |
| destructive | `text-danger`, `hover:bg-danger/10..15`, `border-danger/30` (or solid `bg-danger`) | delete, remove, cancel, reset | safe routine actions |
| link | `text-accent hover:text-accent-hover` | inline navigation / open-in | form submit primary |

Evidence: `TaskDetailModal.tsx` (primary `bg-accent`, destructive `hover:bg-danger/10`), `TaskInfoPanel.tsx:585` (destructive delete).

### State colors

| Role | Token | Use for |
|---|---|---|
| success | `--success` / `--success-hover` (green) | completed, healthy, running dev server |
| warning | `--warning` (yellow) | needs attention, degraded, your-review |
| danger | `--danger` (red) | failed, destructive risk, cancelled |
| awake | `--awake` / `--awake-hover` (amber, both themes) | sleep-prevention active (the header coffee toggle); a distinct "always-on" affordance, not a warning |
| info | **none** (`Proposed`) | no dedicated token; accent/blue reused |

### Status colors — documented exception

`STATUS_COLORS` / `STATUS_COLORS_LIGHT` (`types.ts`) are inline hex for column headers, card borders, and dots. This is the one allowed hardcoded-color case.

## 8. Screen patterns — `Observed`

- **List screen** (dashboard, board): header with create entry; label filter (board) / search (sidebar); per-item context menu; open navigates; compact empty states (decision 047).
- **Detail screen** (task): two-row task header; `TaskInfoPanel` inspector; task-scoped object/git/dev-server actions; full-screen or split terminal.
- **Settings screen** (Global / Project): Global Settings uses a left-nav master-detail layout with seven Settings categories, localized entry search, and immediate RPC/local persistence; Project Settings keeps its existing tabs; destructive removal stays behind confirmation.

Global Settings vocabulary is deliberate: a left-nav item is a **Settings category**, and each searchable/anchored setting is a **Settings entry** registered in `src/mainview/settings-registry.ts`. The registry documents metadata and integrity, while existing bespoke controls own rendering and CRUD behavior. Legacy deep-link ids remain accepted and map through `LEGACY_SETTINGS_CATEGORY_MAP`; Project Settings' internal `global` tab remains labeled “Board” in its UI (known collision, out of scope).

## 9. Complexity budgets

| Surface | Budget | Overflow rule |
|---|---:|---|
| Global nav destinations | 7 | group / demote to menu |
| Page header primary | 1 | demote to secondary |
| Page header secondary | 2 | overflow |
| Task card inline actions | 2 | push to context menu |
| Toolbar visible actions | 4 | overflow after 4 |
| Tabs | 6 | more-menu / subpage |
| Task info panel | 4 bars (2×2), ≤ 4 visible per bar | assign new control to one domain bar; overflow after 4 ⇒ promote that domain to its own row (see §5.1) |

## 10. Placement rules — `Observed`/`Inferred`

| Feature class | Place in | Reject | Rationale |
|---|---|---|---|
| destination | global header, menu `View`, sidebar | card, modal, toolbar | navigation = places, not commands |
| object_action (single task) | inspector, card context menu, menu `Task` | global header, dashboard | actions belong to the object surface |
| git_action | inspector (frequent), menu `Project` (rare) | header, card inline | git surface is already dense |
| configuration | global/project settings | board, inspector, toolbar | durable behavior lives in settings |
| destructive | context menu, confirm, danger zone, overflow | primary button, header | needs friction + destructive styling |
| debug surface | menu `Debug` | header, dashboard, sidebar | dev surfaces must not leak to users |
| diagnostic surface (crash/error) | error boundary around providers, bootstrap phase+timeout state, conditional floating pill (remote + errorCount>0) → `DiagnosticsPanel` | permanent header/toolbar button, nav destination, desktop-shell chrome | faults must be visible where there is no devtools (mobile) without adding happy-path chrome (see §5.5) |
| hint navigation (jump) | `HintOverlay` over any `[data-hint-id]` target; activate with bare `f` / `⌘G` | mutation or destructive targets, visible button | hints are destinations, not actions; keyboard-only avoids button-creep |
| keyboard expert nav | bare-key + `g`-prefix sequences (`g d/p/t/s`), `/` focus search, `c` new task — declared in `keymap.ts`, matched on `e.code` | native menu accelerators (Electrobun can't bind chords/sequences) | layout-independent; reserve `g` for the go-to prefix |
| countable/motivational metric (`data_visualization`) | emit into the stats engine first (`productivity-stats.ts` + `productivityStats.ts`), then a viz on the Velocity Cockpit (`stats`) | controls/config on the cockpit, a new top-level screen per metric, a header counter, diagnostic noise | the cockpit is the one home for shipping signal — keep it read-only and within the honesty/complexity budget (see §1.1) |
| onboarding_help (inline help) | `help.ts` registry topic + HelpSpot in a header-bearing section, or help-mode coverage via `data-help-id`; entries in menu `Help` / `⇧⌘/` / palette | permanent (i) in quickbars/cards/toolbars, hardcoded help strings in components, multi-step tours (v1) | help must add zero chrome to budget-protected zones; content is data, not JSX (see §5.4) |
| feature-gated preset | keep visible in the launch picker but **disabled** (muted + lock) until the gating capability is on; disabled-click → clickable toast that deep-links to the enabling settings section (`OPEN_SETTINGS_SECTION_EVENT` → `Route.section`); the capability's manager is a normal settings section | hiding the preset until enabled, auto-starting the dependency on selection, a bespoke modal | discoverable without a hidden side effect; configuration lives in settings (decision 112) |
| launch favorite (quick-pick) | one compact **leading "Favorites" column** (peer to Provider/Model/Mode, with its own label so it aligns in-row) inside the launch picker (`AgentConfigPicker`, `showFavorites` on Launch/Retry, Spawn, Bug Hunters): a narrow fixed-width trigger showing a Nerd Font **star that fills gold** (`--favorite`) when the current `(agentId,configId)` is saved, opening a left-aligned portal **popover** (`FavoritesMenu`) — top row toggles **Save ↔ Remove** the current combo (gold when saved), below it the favorites list (apply on click, `×` per row removes, accent + check on the active one). Column is **always present** (save reachable at 0 favorites). NO persistent chip row, NO 1-click row star. Stored globally (`GlobalSettings.favorites`), cap 10, LFU-then-LRU eviction | a persistent chip row above the cascade (duplicates N× across variant pickers + vertical bloat), a right-side `[★│▾]` split (dangles below the Selects, misaligned), a 4th text dropdown eating width ×N, a favorites pseudo-provider, favorites in the Settings default-agent pickers, click-to-launch | the launch picker is instantiated **once per variant** in `LaunchVariantsModal`, so a persistent row rendered inside it duplicated the identical global list N times and pushed the cascade down; a leading labeled column with a narrow star trigger keeps favorites one earned icon (button-creep budget §11), aligned in-row, zero added height, and each trigger unambiguously targets its own picker (decision 125, sibling to 112) |

## 11. Known anti-patterns in this project

- **Toolbar button creep** — the changelog shows repeated additions of always-visible git/tmux/dev-server buttons (`always-visible-git-buttons`, `tmux-action-buttons`, `push-button`, `create-pr-button`, …). `TaskInfoPanel` (34K) and `TaskCard` (33K) are the pressure points. For `TaskInfoPanel`, follow the §5.1 bar model: assign each new control to one domain bar; do not pile everything into row-1-right. Group or overflow before adding.
- **Hardcoded colors** — raw hex/rgb instead of semantic tokens (forbidden except `STATUS_COLORS`).
- **Untranslated strings** — UI strings must use `t()` and exist in en/ru/es.
- **Actions in breadcrumbs** — header is location + switching only.
- **Debug-surface leak** — `gauge-demo` / `viewport-lab` outside the Debug menu.
- **Touch-unreachable feature** — an action whose only path is a keyboard shortcut (Cmd+K/Cmd+Shift+P/Cmd+1..9/hint overlay) or the native application menu. On narrow (<768) it is dead, because the native menu is absent in remote and there is no keyboard. Every feature needs a touch path (palette touch entry, action sheet, or inline control). See §12.4.
- **Fixed-width overlay on narrow** — a `Modal`/palette/popover with a hardcoded `w-[NNrem]` and no `max-w-[calc(100vw-2rem)]` overflows a 390px phone (`PaletteShell` 34rem, `TaskDetailModal` 35rem, `confirm()` 26rem, diff aside 22rem). Overlays must clamp to the viewport on narrow. See §12.3.
- **Non-wrapping toolbar on narrow** — an icon/action row (`flex … justify-end` / `justify-between`, no `flex-wrap`) that silently overflows under 768px (GlobalHeader ≤9 buttons, TaskCard footer, inspector collapsed bar). On narrow, wrap or move to a bottom sheet — never a clipped row. See §12.6.
- **Gating layout on `isElectrobun` instead of width** — transport ≠ viewport width. Browser/remote can be wide; desktop can be narrowed. Gate layout on `useNarrowViewport`; use `isElectrobun`/`useMobile` only for transport/viewport-meta decisions. See §12.1.

## 12. Narrow-viewport (mobile) doctrine — board `Observed`, rest `Proposed`

The app's secondary form factor is a **phone reached over `dev3 remote`** (any sub-768px viewport: a phone browser, a narrowed desktop browser window, or a hypothetical Electrobun-mobile build). The desktop UI is dense, wide, and keyboard-first; it must **degrade to a touch-first, one-thing-at-a-time form** on narrow screens — without becoming a second app. This section is the canonical ruleset; the Kanban board carousel (Ittai Zeidman's idea) is the **reference implementation** the rest generalises from. Full plans preserved in git history (removed feature-plans/).

**The one principle:** *On a narrow viewport, show exactly one sibling at a time and move between siblings by swipe + a visible pager.* Columns, tasks-in-a-column, terminal panes, active tasks, settings sections, diff files — all collapse to the same one-at-a-time carousel/stack idiom. This is a **responsive view-mode of existing screens**, never a new destination, nav item, route, or "mobile mode" setting. Layout follows the viewport automatically.

### 12.1 Breakpoint ladder — `Observed` (reconciled)

Three distinct widths exist in code; they are **not** the same thing and must not be conflated:

| Name | Width | Hook / signal | Reactive? | Governs |
|---|---:|---|---|---|
| **narrow (mobile)** | `< 768px` | `useNarrowViewport(768)` (matchMedia, `CAROUSEL_MAX_WIDTH`) | yes | **the mobile doctrine** — carousel/stack/sheet layout switch. This is THE gate. Aligns with Tailwind `md`. |
| **compact** | `< 1600px` | `useCompact()` (`COMPACT_MAX_WIDTH`) | yes | dense-desktop label hiding + header overflow kebab; **not** mobile. A wide-but-not-huge desktop is compact, not narrow. |
| **device-class** | `screen.width < 1024` | `useMobile()` | no (mount-once) | viewport-meta decision plus the **portrait-only device guard** — is this physically a small device. NOT a layout gate. |

Rules: **gate layout on `useNarrowViewport`** (reactive, viewport-width). Use `useMobile()` for the `<meta viewport>` choice and the portrait-only device guard. Never gate a layout on `isElectrobun` (transport ≠ width) — browser mode can be wide, desktop can be narrowed. `useViewport()` serves **device-width** to the browser so a phone reports its true width and the media queries fire (the old fixed `width=1024` is replaced). The earlier "sub-1024 / `useMobile`" wording was wrong for layout — the shipped layout gate is **768 / `useNarrowViewport`**.

**Portrait-only device guard — `Observed`:** A physically small device is locked to portrait when the browser permits the Screen Orientation API. If the lock is unsupported or rejected outside fullscreen, `MobilePortraitGate` blocks the root shell in landscape with a localized rotate-to-portrait prompt and makes the underlying app inert. Narrowed desktop windows are unaffected because they are not the mobile device class.

### 12.2 The one-at-a-time pattern + gesture law

| Surface class | Narrow form | Swipe rule |
|---|---|---|
| **scroll-body** (board columns, lists, settings sections) | one sibling = 100vw via CSS `scroll-snap`; the body scrolls on the *other* axis | **full-surface swipe allowed** — the body scrolls vertically only, so horizontal motion is unambiguous (delegate axis disambiguation to the browser) |
| **live-content** (terminal pane, diff stream, any canvas/TUI) | one element + a position indicator (dots) | **full-surface swipe allowed, but axis-arbitrated** — the content consumes touch (vim/htop/less, code scroll), so the handler claims a gesture only once it is *clearly horizontal* (capture-phase `preventDefault`+`stopPropagation`, cancel any nascent selection); vertical drags and taps fall through to the content. Native `scroll-snap` can't do this (a canvas has no sibling slides) → manual gesture. *(Revised 2026-06-29 — was "swipe forbidden, pager only"; a bottom pager bar collides with the mobile keyboard. See decision 089.)* |

**Gesture law (always):** every swipe has a **button + keyboard equivalent** (pager chevrons, dots, Arrow Left/Right); swipe is never the only way. Focus follows the active sibling's heading; `aria-live` announces it. `prefers-reduced-motion` snaps instantly (no smooth scroll) — and this must be honoured **everywhere**, not only in the carousel (it currently is only in `MobileBoardCarousel`).

### 12.3 Per-surface adaptation map — `Observed` (board) / `Proposed` (rest)

Every surface from §5 gets an explicit narrow form. "—" = unchanged.

| Surface | Desktop form | Narrow (<768) form | Status |
|---|---|---|---|
| Mobile orientation | natural device orientation | **portrait-only device guard**; best-effort platform lock plus a blocking rotate prompt fallback in landscape | `Observed` (`MobilePortraitGate`, `usePortraitOrientation`) |
| Kanban board | all columns side-by-side | **column carousel** (one column/screen, swipe; vertical task scroll; collapsed cols excluded, empty kept) | `Observed` |
| Task move (drag) | drag card across columns | drag impossible → **"Move to <status>" action sheet** (long-press card) on the existing status path; completion reuses `confirmTaskCompletion` | `Proposed` |
| Board filters/search | inline `LabelFilterBar` + `FilterFunnel` dropdown (token-DSL) | **bottom sheet** behind the funnel button (same grouped facets) | `Proposed` |
| Terminal panes | tiled tmux panes | **pane carousel** — one zoomed pane + axis-arbitrated horizontal swipe over the terminal, a slim non-overlapping top dots strip, Arrow keys; keep-zoom via `tmuxPaneNavigate` (`MobilePaneCarousel.tsx`) | `Observed` |
| Terminal windows | tmux windows (workspaces) | **window switcher** — a slim ‹ prev · named dropdown · next › bar ABOVE the pane bar, buttons + dropdown + Arrow-while-focused (no swipe; the terminal swipe is the pane carousel's). Renders only when window count > 1; via `tmuxWindowNavigate` (`MobileWindowCarousel.tsx`) | `Observed` |
| Terminal text input (touch) | direct typing into the focused terminal | **docked composer** (gate = `!isElectrobun && isTouchDevice`, NOT width — an input-model switch): terminal tap never summons the OSK; an autogrow chat-style composer between the terminal and `ExtraKeyBar` owns text entry (Send = mode-2004-aware paste + Enter; Insert = paste only; expand state for long prompts; terminal tail stays visible); sticky `⌨` **raw** toggle on `ExtraKeyBar` restores direct typing + select-to-copy/TUI mouse; covers Quick Shell too. See `UX_DECISIONS.md` (2026-07-02) | `Proposed` |
| Active tasks | `ActiveTasksSidebar` (split, 240px) | no persistent task strip; use the existing task-switcher overlay and breadcrumb → board carousel to change tasks | `Observed` (strip removed 2026-07-19) |
| Task inspector (`TaskInfoPanel`, 2×2 bars) | 2×2 quickbar grid | the 2×2 cannot fit — collapse to **one summary bar + a "task actions" bottom sheet** (the bars' actions become sheet sections); metadata grid already reflows | `Proposed` |
| Diff viewer | 22rem files-aside + diff stream | **stack/one-at-a-time** — files-aside becomes a bottom-sheet file picker; the diff stream owns the screen (live-content: pager/explicit nav, no full-surface swipe) | `Proposed` |
| Modal (`*Modal`) | fixed 26–35rem centered | **full-bleed sheet**: `max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]` (or bottom-sheet for action-style modals) | `Proposed` |
| Context menu (right-click) | popup at cursor | **bottom action sheet** (long-press trigger) | `Proposed` |
| Settings (left-nav + detail) | left-nav Settings categories + one category detail pane; localized search groups registered Settings entries | **category list first → one category detail at a time** with a visible back affordance; same route and persistence, no horizontal overflow | `Observed` (`GlobalSettings.tsx`, `settings-registry.ts`) |
| Dashboard (Activity) | project list + hover action icons + drag-reorder | vertical list, full-width cards (`p-3` not `p-7`); per-project actions **+ reorder** collapse into a **kebab → `BottomSheet` action sheet** (hover cluster, HTML5 drag, and the `hidden md:flex` up/down steps are all dead on touch); touch targets ≥44px | `Observed` |
| Command palette (Cmd+K / Cmd+Shift+P) | keyboard-summoned, `34rem` | needs a **touch entry** + `w-full max-w-[calc(100vw-2rem)]` — see §12.4 (it is the action fallback for the absent native menu) | `Proposed` |
| Global header | single row, ≤9 utility buttons | reflow: logo + truncated breadcrumb + **one overflow (kebab)** for all utilities; never a 9-icon row (`useCompact` at 1600 only hides labels, it does not reflow for 390px) | `Proposed` |
| Hover terminal preview | popover on card hover | **disabled** on touch/narrow (no hover; popover obscures) — already gated in `useTerminalPreview` | `Observed` |
| Task image viewer | lightbox + thumbnail rail | full-bleed; filmstrip → bottom scroll strip; image is live-content (axis-arbitrated swipe + prev/next + dots); touch entry = inspector badge + palette action | `Proposed` |
| Task artifact workspace | resizable panel beside terminal | one-at-a-time: artifact replaces terminal content; close returns to terminal; fullscreen remains available | `Observed` |
| Toast | top-right, clamped | already `max-w-[calc(100vw-2rem)]` — OK | `Observed` (OK) |

### 12.4 Navigation & action reachability on touch — `Proposed`

Mobile's hardest gap: **the keyboard-first nav layer is dead on a touchscreen, and the native application menu is absent in remote mode.** Keyboard-only and therefore unusable on a phone: Cmd+K / Cmd+Shift+P palettes, Cmd+1..9 project switch, the Cmd+/ hint overlay. The native menu (task moves, git, dev-server) does not exist in the browser at all.

Doctrine:
- **The breadcrumb spine stays the touch nav backbone**: logo→dashboard, project name→board, project chevron→switcher dropdown, back/forward. These must remain reachable (not pushed off-screen by a long task title) — give the project switcher a touch-sized target (≥44px) and a `right-0` fallback so the dropdown never clips.
- **The command palette gains a touch entry on narrow** (a single search/jump affordance) and a responsive width. Because the native menu is gone in remote, the **action palette / per-object action sheets become the canonical action surface on mobile** — every action that on desktop lives only in the native menu must be reachable on mobile via a palette entry or an object action sheet. This is the one sanctioned exception to "palettes are keyboard-only / no button" — on narrow, a touch entry is mandatory, not button-creep.
- **The browser application menu bar is a wide-layout surface**: hide its standalone row below 768px so the existing GlobalHeader `More` bottom sheet and command palette remain the compact touch entry points; desktop/browser menu parity is unchanged.
- **No feature may be touch-unreachable.** If an action's only desktop path is a keyboard shortcut or the native menu, it MUST have a touch path on narrow (action sheet, palette, or inline control).

### 12.5 Overlay primitive — `BottomSheet` (new, mandated) — `Proposed`

The doctrine needs **one** reusable bottom-sheet primitive; none exists today (only centered `Modal`, `confirm()`, `toast`, `Popover`). `BottomSheet` is the narrow rendering for: context-menu→action-sheet, board filters, column-jump list, "Move to", the inspector actions sheet, the diff file picker, and the narrow form of action-style modals. It must: slide from the bottom, respect `env(safe-area-inset-bottom)`, trap focus, restore focus on close, dismiss on backdrop tap / swipe-down / Esc, and be a pure React component (works identically in desktop and browser — no native dialog, per the project's no-native-dialogs rule). Build it once; do not scatter ad-hoc sheets.

### 12.6 Narrow complexity budgets & touch targets — `Proposed`

| Surface | Narrow budget | Overflow rule |
|---|---|---|
| Global header utilities | logo + breadcrumb + **1** overflow kebab | everything else into the kebab/sheet |
| Page primary action | 1 (a FAB or header button) | rest into a bottom sheet |
| Inspector | 1 summary bar | all actions into the actions sheet |
| Any toolbar/action row | wrap or sheet — **never** a non-wrapping overflow row | move to bottom sheet |
| Touch target | **≥ 44×44px** | many current controls are 32px / `p-0.5` — bump on narrow |

### 12.7 Accessibility, motion, input — `Proposed`

- Honour `prefers-reduced-motion` on every animated transition (currently only the carousel).
- Keep the `.browser-mode` 16px input-font rule (prevents iOS focus-zoom); honour `env(safe-area-inset-*)` (the viewport already sets `viewport-fit=cover`).
- Reuse the `TerminalView` touch→mouse bridge model for any canvas surface; reuse `ExtraKeyBar`'s vw-based sizing for mobile toolbars.
- Carousels: `aria-roledescription="carousel"`, siblings as `group`/`tabpanel`, pager as the tablist; arrow-key support when the pager is focused.

## 13. Open questions

- Multi-select + a real selection toolbar on the board, or is per-task action intentional?
- Add an `--info` token, or keep reusing accent (blue)?
- `ProjectSettings` (59.9K) is still very large — does it need a documented sub-surface budget or splitting? (`TaskInfoPanel` is now governed by the §5.1 bar model.)
- Should status colors migrate to named theme tokens, or stay as the documented hex exception?
- Narrow nav: is a persistent bottom tab bar (Dashboard · Board · Task · More) the right touch nav spine, or do the breadcrumb + a touch palette entry suffice? (§12.4)
- Does the mobile primary action want a FAB, or stay in the (reflowed) header? One per screen either way. (§12.6)
- Should `useMobile()` become reactive (it is mount-once at 1024) so the viewport-meta decision tracks live resizes, or is mount-once acceptable since device class rarely changes mid-session? (§12.1)

## 14. Glossary

Shared UX vocabulary, specialized for this project (was `UX_GLOSSARY.md`).

- **Destination** — a stable place users navigate to; in dev-3.0 a **screen** in the `Route` union (`dashboard`, `project`, `task`, `settings`, …), not a URL.
- **Action** — a command that changes state or performs work: primary, object, git, dev-server, lifecycle, configuration, destructive, expert-shortcut.
- **Surface** — a UI container that owns a class of interaction: global header, application menu (native), Kanban board, task card, task info panel (inspector), modal, popover, context menu, settings, sidebar, toast.
- **Primary action** — the one main safe action for the current screen/flow. Styled `bg-accent`. Max one visible per screen.
- **Destructive action** — delete, remove, cancel, reset, hard refresh. Styled `text-danger`/`bg-danger`, requires confirmation, never primary styling.
- **Configuration** — a durable change to project/app behavior (scripts, columns, labels, theme, locale, gh account). Lives in Global or Project Settings.
- **Settings category** — one of the seven Global Settings navigation items: Appearance, Tasks & Board, Terminal, Agents, Accounts, Workspace, or System.
- **Settings entry** — a registry-described individual setting with localized title/description metadata and an optional scroll anchor; its bespoke control remains owned by the category surface.
- **Complexity budget** — a project-specific cap on visible controls per surface (e.g. ≤2 inline actions on a task card, ≤4 visible toolbar actions); exists because of dev-3.0's documented toolbar-button-creep history.
- **Inspector** — the `TaskInfoPanel`: the contextual control surface for the active task (git, dev server, scripts, notes, tmux, open-in). The densest surface in the app.
- **Variant / Attempt** — multiple parallel agent runs of the same task (a *variant group*, shared `groupId`/seq; "group" is reserved for this concept — feature grouping is **Epic**). Each variant stays its own honest card; group affordance is one unified pattern on both card surfaces: **≤ 3 clickable status dots** (self ring-highlighted + lowest indexes, no `+N`) opening the **SiblingPopover** group overview (per-variant title, agent/config, status, current marker), plus the inspector Context-bar **variant switcher** and the `⇧⌘[`/`⇧⌘]` cycle for in-workspace switching. Never collapse a group into one card.
- **Custom column** — a user-defined Kanban column with a name, color, optional LLM instruction, and optional auto-spawn agent config.
- **Token** — a semantic CSS custom property (`bg-accent`, `text-fg`, `border-edge`, `--success`…) mapped to Tailwind; components must use tokens, never raw hex — except `STATUS_COLORS`.
- **Status color** — per-status hex (`STATUS_COLORS` / `STATUS_COLORS_LIGHT`) used inline for column headers, card borders, and dots; the one documented exception to the no-hardcoded-color rule.
