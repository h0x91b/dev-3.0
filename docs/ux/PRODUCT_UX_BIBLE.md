# Product UX Bible — dev-3.0

Status: Draft (initial)
Source: Derived from repository audit
Last updated: 2026-05-29
Owner: Product UX Architecture

Evidence notation: `Observed` (backed by code/docs), `Inferred` (likely rule from repeated patterns), `Proposed` (recommended, not yet consistent), `Unknown` (insufficient evidence).

## 1. Purpose

Canonical UX architecture reference for dev-3.0. It defines how the app organizes navigation, screens, surfaces, actions, and design-token roles, and where new features should live. Agents must consult this (via the `ux-principal` skill) before adding UI.

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
| Task | `project` (card) | `task` (full terminal) / split in `project` | project | create, move status, rename, set overview, note, spawn variants, add attempts, duplicate, delete, watch, open-in, git, dev-server | `types.ts (Task)`, `TaskCard.tsx`, `TaskInfoPanel.tsx`, `application-menu.ts` |
| Label | — (overlay on tasks) | — | project | create, rename, recolor, assign, filter | `types.ts (Label)`, `LabelPicker.tsx`, `LabelFilterBar.tsx` |
| Custom Column | — (board column) | — | project | create, rename, recolor, set LLM instruction, attach agent | `types.ts (CustomColumn)`, `KanbanBoard.tsx` |
| Note | — (in inspector) | — | task | add, edit, delete | `types.ts (TaskNote)`, `NoteItem.tsx`, `task-info-panel/TaskNotes.tsx` |

Task lifecycle states (`ALL_STATUSES`): `todo`, `in-progress`, `user-questions`, `review-by-ai`, `review-by-user`, `review-by-colleague`, `completed`, `cancelled`. Most transitions are hook-driven, not manual.

## 4. Navigation model — `Observed`

The app uses a **screen router** (`Route` union + `useReducer` with a 15-entry back/forward history), not URLs.

### Global navigation

Destinations: `dashboard`, `project` (Kanban — the daily home), `task`, `project-terminal`, `home-terminal`, `settings`, `project-settings`, `changelog`. Debug-only: `gauge-demo`, `viewport-lab`.

Mechanism: `GlobalHeader` breadcrumbs (`Dashboard > Project > Task`) + back/forward + native application-menu `View`.

- **Allowed:** stable destinations, workspaces, major product areas.
- **Forbidden:** one-off actions, filters, temporary state, object-specific controls.
- **Budget:** ≤ 7 top-level destinations, max depth 2. Debug screens stay menu-only.

### Breadcrumbs — `Observed`

Show location only. Text click navigates; the project chevron opens a **project-switcher dropdown**. No commands in breadcrumbs.

Evidence: `GlobalHeader.tsx`.

### Tabs — `Observed`

Only in `project-settings` (`global | project | worktree`). Budget ≤ 6 visible tabs.

## 5. Surface model — `Observed` unless noted

| Surface | Purpose | Allowed | Forbidden | Evidence |
|---|---|---|---|---|
| Global header | Location + switching + app utilities | breadcrumb, destination, project switcher, settings/changelog entry, tmux manager, prevent-sleep (awake) toggle | task-scoped action, dense filters, destructive primary | `GlobalHeader.tsx` |
| Application menu (native) | Canonical home for the full action taxonomy | every action type | — | `application-menu.ts`, `menu-actions.ts` |
| Kanban board | Primary work surface | task cards, create-in-column, drag-move, column config, label filter | durable global config | `KanbanBoard.tsx`, `KanbanColumn.tsx` |
| Task card | Compact task summary | status dot, labels, variant dots, open, context menu, git badge | full settings, global destination | `TaskCard.tsx` (large — watch density) |
| Task info panel (inspector) | Active-task control: git, dev server, scripts, notes, tmux, open-in | object/git/dev-server actions, metadata, notes | global destination, cross-project action | `TaskInfoPanel.tsx` (densest surface) |
| Modal | Focused create/confirm | create flow, confirm, focused config | navigation, persistent dashboard | `*Modal.tsx` |
| Popover | Contextual preview/hint | preview, hint, quick action, remediation | multi-step flow, primary destination | `*Popover.tsx` |
| Context menu | Right-click object actions | object action, open-in, destructive | global destination | `OpenInMenu.tsx` |
| Settings | Durable configuration | configuration, preference, integration, scripts | daily operational action | `GlobalSettings.tsx`, `ProjectSettings.tsx` |
| Sidebar | Active-task jump list | destination, task jump, terminal preview, search | durable config | `ActiveTasksSidebar.tsx` |
| Toast | Transient feedback | status, error | persistent/primary action | `ErrorToast.tsx` |

Note: native menu is the **overflow/expert** surface; frequent actions are mirrored into DOM toolbars (inspector, board).

### 5.1 Task info panel — bar model (2×2) — `Observed`

The inspector header (`TaskInfoPanel.tsx`, both collapsed and expanded states) is a **2×2 grid of quickbars**: two rows, each split into a left and a right bar by a `flex-1` spacer. This exploits the wide desktop width instead of stacking more rows above the terminal (the panel has a hard height budget, `MAX_RATIO = 0.33`). **Each bar owns exactly one action domain. Panel chrome is not a bar.**

| Bar | Position | Domain | Contents | Evidence |
|---|---|---|---|---|
| Context | row 1, left | task identity & lifecycle | watch toggle, status dropdown, diff-summary badge, include-tests toggle, label strip | `TaskInfoPanel.tsx` (row 1 left cluster) |
| Session/Agent | row 1, right | drive the session & agents | spawn extra agent, bug hunters, tmux controls | `TaskInfoPanel.tsx` (row 1 right cluster), `TaskTmuxControls.tsx` |
| Git | row 2, left | branch & PR | branch name/status, show diff, refresh, copy worktree path, open PR | `task-info-panel/TaskGitActions.tsx` |
| Runtime & access | row 2, right | project runtime outputs + access to them | open-in (editor/file browser), scripts, dev server (start/stop/restart/status); ports/resources shown as detail in the expanded body | `task-info-panel/TaskOpenIn.tsx`, `task-info-panel/TaskScripts.tsx`, `task-info-panel/TaskDevServer.tsx` |

Rules:

- **Row 1 = "Drive"** (what the task is + how I control its session). **Row 2 = "Outputs"** (what the work produces and how I access it: branch/PR + open-in/scripts/running server). open-in lives here because it opens the produced worktree, and it keeps the Runtime bar balanced (3 controls) instead of leaving it sparse.
- **Chrome** (collapse/expand, fullscreen toggle, ⚙ worktree-settings) is pinned to the far right edge of row 1 and is **not** counted as a bar or against any bar's budget.
- A new control must be assigned to exactly one domain and placed in that bar. Do not drop it into whichever bar has room — that is how the pre-2026-06 "everything in row-1-right" dumpster happened.
- **Label overflow:** the Context bar shows up to `MAX_INLINE_LABELS` (4) chips inline, then a `+k` chip (hover lists the rest). The full label list still renders in the expanded metadata grid, so the inline strip may truncate safely.
- Per-bar visible-action budget stays at the toolbar default (≤ 4 visible, then overflow). If Runtime or Session/Agent overflows, promote it to its own dedicated row before widening past the budget.

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
- **Settings screen** (Global / Project): grouped sections (Agent, Appearance, Behavior, Workspace, DeveloperTools); RPC save; destructive removal behind confirmation.

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

## 11. Known anti-patterns in this project

- **Toolbar button creep** — the changelog shows repeated additions of always-visible git/tmux/dev-server buttons (`always-visible-git-buttons`, `tmux-action-buttons`, `push-button`, `create-pr-button`, …). `TaskInfoPanel` (34K) and `TaskCard` (33K) are the pressure points. For `TaskInfoPanel`, follow the §5.1 bar model: assign each new control to one domain bar; do not pile everything into row-1-right. Group or overflow before adding.
- **Hardcoded colors** — raw hex/rgb instead of semantic tokens (forbidden except `STATUS_COLORS`).
- **Untranslated strings** — UI strings must use `t()` and exist in en/ru/es.
- **Actions in breadcrumbs** — header is location + switching only.
- **Debug-surface leak** — `gauge-demo` / `viewport-lab` outside the Debug menu.

## 12. Open questions

- Multi-select + a real selection toolbar on the board, or is per-task action intentional?
- Add an `--info` token, or keep reusing accent (blue)?
- `ProjectSettings` (59.9K) is still very large — does it need a documented sub-surface budget or splitting? (`TaskInfoPanel` is now governed by the §5.1 bar model.)
- Should status colors migrate to named theme tokens, or stay as the documented hex exception?
