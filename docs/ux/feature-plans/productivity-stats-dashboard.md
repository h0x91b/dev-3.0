# Feature Plan — Productivity Stats Dashboard ("Velocity Cockpit")

Status: Proposed (planning via /ux-principal, 2026-06-28)
Owner: dev-3.0 product
Related: complements the Automations task (AI-generated narrative reports) — this is the quantitative companion.

## 1. Feature in one line

A stylish, full-screen **showcase surface** that proves how much the developer ships: tasks completed over time, lines of code changed, projects/tasks/agents counts, streaks, busiest project, per-project breakdown — presented as a **cockpit of speedometer gauges** + bar/line charts, with a day/week/month/all time-range switch.

## 2. Why it earns a place

- Directly serves the product positioning: **individual developer SPEED + "managing yourself / staying oriented"**. A wall of speedometers is the literal visual metaphor for velocity.
- Explicitly a **marketing / demo-reel surface** (the founder's brief) — it must be beautiful, ties to the "beauty" value.
- Reuses the user's beloved `Gauge` speedometer component heavily (the core requirement).

## 3. Feature classification

- **Feature class:** `destination` (a durable product area) + `data_visualization`.
- **Owning object:** workspace-global (cross-project aggregate), not a single task/project.
- **Scope:** global.
- **Frequency:** occasional (check-in, show-off), not constant.
- **Risk:** safe, read-only. No mutations, no destructive actions.

## 4. Placement decision

### Surface

A **new top-level screen** `stats` (the `Route` union gains `{ screen: "stats" }`). Rendered full-screen like `dashboard` / `changelog`.

### Navigation budget check

Real (non-debug) destinations after the virtual-board work removed `home-terminal`:
`dashboard, project, task, settings, project-settings, changelog` = 6. Adding `stats` = **7**, exactly at the documented `max_top_level_items: 7` budget. Debug screens (`gauge-demo`, `viewport-lab`) stay menu-only and are excluded from the count. Within budget — no consolidation needed.

### Entry points (DECIDED 2026-06-28 by the user: a **Dashboard card**, NOT a header button)

1. **Dashboard card** (primary) — a prominent entry tile/card on the Dashboard (`ActivityOverview` / `Dashboard.tsx`) that navigates to `stats`. The user explicitly chose this over a GlobalHeader button (rejected to keep the header uncluttered). It doubles as marketing prominence on the home screen.
2. **Native View menu** entry (`application-menu.ts`) — the canonical destination surface; every top-level screen lives here. Zero visible chrome cost.
3. **Command palette** (`⇧⌘P`) — a `commands.ts` navigation entry routing through `handleMenuAction`.
4. **NO GlobalHeader button** (per user decision). **`g`-prefix go-to** not in MVP.

### Rejected placements

- **Inside Dashboard (`ActivityOverview`)** as a panel/tab — rejected as the *primary* home: the dashboard is the project list; a heavy gauge cockpit would bloat it and fight the list's scan pattern. (A small "View stats" link on the dashboard is an acceptable *secondary* entry — optional, see open question O1.)
- **Settings** — rejected: this is an operational/showcase surface, not durable configuration.
- **Breadcrumb integration** — rejected: it is a sibling top-level destination (like Dashboard/Changelog), not a child of Project/Task.

## 5. Information architecture of the screen

Top → bottom, all re-scoped by the global **time-range switch** (Day / Week / Month / All — segmented control, top-right of the screen header; persisted in `localStorage` like the diff-mode control).

### 5.1 Hero gauge row — the cockpit (PRIMARY gauge usage)

A responsive row of large `Gauge` speedometers (size ~190–220). These answer "how fast am I shipping *right now*":

1. **Tasks shipped** — value = completed tasks in the selected period; `max` = dynamic (rolling historical peak for that granularity × 1.2, min sensible floor); `unit` = period label ("this week"). The flagship gauge.
2. **Lines changed** — value = LOC (insertions + deletions) in the period; `max` = rolling peak; `formatLabel` = compact K/M. ⚠️ forward-only data (see §7).
3. **Velocity** — value = tasks/day (or /week) average for the period; `max` = rolling peak.
4. **Completion rate** — value = completed ÷ (completed + cancelled) × 100; `max` = 100; `unit` = "%"; `redZone` low (e.g. < 40%) so a low rate visibly enters the red — the one natural redZone use.
5. **Current streak** — value = consecutive active days; `max` = best streak; `unit` = "days".

Each hero gauge sits in a card with a small caption + a **trend delta vs previous period** (▲/▼ %, colored success/danger). Number + trend live *below* the gauge so the gauge stays the visual hero.

### 5.2 Time-series charts (custom SVG — no chart lib)

- **Tasks completed over time** — vertical **bar chart**, one bar per bucket (day/week/month per the range). The backbone time-series. Accent-filled bars, `border-edge` baseline, value-on-hover.
- **Lines changed over time** — **area/line chart** (forward-only). Rendered below or beside the bar chart.

Both built as pure SVG + design tokens (accent/success/danger/`border-edge`/`text-fg-*`), theme-aware, following the `Gauge` self-contained pattern but using **semantic tokens** (charts are new chrome → token rule applies; the Gauge is a pre-existing self-styled component and is reused verbatim).

### 5.3 Per-project breakdown (SECONDARY gauge usage — small multiples)

A grid of **small gauges** (size ~110–130), one per project that has activity in range, each showing that project's completed-task count (or its share of total). This is where the gauge gets used "as much as possible" — a wall of mini-speedometers. Busiest project highlighted (accent ring / ⚡ marker). Sorted by activity desc.

### 5.4 Headline counters strip

A compact row of big-number stats with tiny captions (not gauges — keeps density honest): **# tasks**, **# projects touched**, **# agents run** (approx), **all-time tasks shipped**, **best streak**. Small and quiet; the gauges are the stars.

## 6. Data + backend plan

### 6.1 Source (all local, confirmed by investigation)

- Completion timestamp: `task.movedAt` when `status === "completed"` (terminal status; reliable). Full history available — completed tasks persist in `tasks.json` (only `deleteTask` removes them).
- Enumerate: `loadProjects()` + `loadVirtualProjects()` → `loadTasks(project)` per project.
- Counts: tasks, projects, agents-run (approx via `agentId` present + `groupId`/`variantIndex`).
- Per-project / busiest / streak: derived from completed `movedAt` + `projectId`.

### 6.2 LOC capture (new — the only schema/lifecycle change)

- Add optional `Task.completedDiffStats?: { files; insertions; deletions; capturedAt }`.
- In `moveTask()` (`task-lifecycle.ts`), for non-virtual tasks, **before** `git.removeWorktree()`, call `git.getBranchDiffStats(worktreePath, baseRef)` and persist via `data.updateTask`. Wrapped in try/catch — failure must never block completion.
- For **active** (not-yet-completed) tasks the stats RPC computes diff **live** from the existing worktree, so in-flight work contributes LOC immediately.
- **Honest limitation:** tasks completed *before* this ships have no captured stats (worktrees gone). LOC gauges/charts show only data from tracking-start forward, with a subtle empty/"tracking since" treatment. (Best-effort historical backfill from surviving `diffs/*.patch` snapshots is a possible later enhancement — out of MVP scope; see open question O2.)

### 6.3 RPC

New handler module `src/bun/rpc-handlers/productivity-stats.ts` exporting `getProductivityStats()`. Returns a compact **per-task stat-event list** (taskId, projectId, projectName, projectKind, status, createdAt, completedAt, insertions, deletions, files, agentId, groupId, variantIndex) + a `generatedAt`. The renderer buckets/aggregates per selected range client-side → instant range switching, one fetch. Registered in `AppRPCSchema` (`src/shared/types.ts`) and the `rpc-handlers.ts` barrel.

## 7. States

- **Empty (no completed tasks yet):** friendly empty state — "Ship your first task to light up the dashboard" + a dim gauge at 0. No error.
- **LOC not yet tracked:** LOC gauge shows 0 / dim with a one-line "tracking started <date>" hint; LOC chart shows the post-tracking window only.
- **Loading:** skeleton cards / gauges at 0 with a subtle shimmer.
- **Error:** toast (no native dialog), screen shows last-known or empty.

## 8. Tokens & components

- **Reuse `Gauge`** verbatim (`src/mainview/components/gauges/Gauge.tsx`) — theme="auto". Its self-contained Porsche palette is an accepted pre-existing exception; do NOT refactor it to tokens.
- **New chart components** use semantic tokens only (accent/success/danger/warning, `bg-raised`/`bg-elevated`, `text-fg-*`, `border-edge`). No hardcoded hex.
- i18n: all strings via `useT()`; new domain file `stats.ts` in en/ru/es.
- Nerd Font glyphs for the nav icon + card icons.

## 9. Scope / staging (PR-sized)

- **Stage 1 — Data plumbing:** `Task.completedDiffStats` type + capture in `moveTask` + `getProductivityStats` RPC + barrel + tests.
- **Stage 2 — Screen shell:** `stats` route, `ProductivityStatsView` component, App.tsx wiring, GlobalHeader button + compact overflow, View-menu + palette entries, i18n `stats.*`, keymap note if any shortcut.
- **Stage 3 — Gauge cockpit:** hero gauge row + counters strip + time-range switch + trends.
- **Stage 4 — Charts + per-project gauges:** SVG bar/line components, per-project small-gauge grid, streaks/busiest.
- **Stage 5 — Finish:** tips (1–2 "Did you know?"), tests to coverage, manifest + UX_DECISIONS update, decision record, changelog entry, green lint+test.

## 10. What NOT to build

- No external charting library (project keeps deps minimal — pure SVG).
- No mutations/actions on this surface (read-only showcase).
- No per-status audit history (not needed; `movedAt` suffices). `statusHistory[]` is a documented *future* option only.
- No refactor of the `Gauge` component's styling.
- No breadcrumb entry; no new destructive/config controls.

## 11. Files likely to change

- `src/shared/types.ts` (Task field, RPC schema, Route union via state.ts).
- `src/mainview/state.ts` (Route union).
- `src/bun/rpc-handlers/productivity-stats.ts` (new), `src/bun/rpc-handlers.ts` (barrel), `src/bun/git.ts` (reuse existing), `src/bun/rpc-handlers/task-lifecycle.ts` (capture).
- `src/mainview/components/ProductivityStatsView.tsx` (new) + chart subcomponents under `components/stats/`.
- `src/mainview/App.tsx` (renderScreen case + nav wiring), `src/mainview/components/GlobalHeader.tsx` (button + overflow).
- `src/bun/application-menu.ts` + `menuRouter.ts` + `commands.ts` (View menu + palette).
- i18n `translations/{en,ru,es}/stats.ts` + barrels; `tips.ts` + tip i18n.
- Docs: `ux-architecture.yaml`, `PRODUCT_UX_BIBLE.md`, `UX_DECISIONS.md`, a `decisions/NNN-*.md`, a `change-logs/...` entry.

## 12. Resolved decisions (user, 2026-06-28)

- **O1 — Entry point:** RESOLVED → **Dashboard card only** (no GlobalHeader button). View-menu + palette still added (standard for a destination, zero chrome).
- **O2 — LOC history:** RESOLVED → **Forward-only** (LOC accrues from ship time; live for active tasks). No `.patch` backfill in scope.
