# UX Principal Report: Dashboard "Activity" view — narrow-viewport refinement

Date: 2026-06-30
Mode: planning only (implementation brief; no product code yet)
Manifest status: refines narrow-viewport-doctrine §4 row "Dashboard … ok". That row only
asserted "full-width cards"; it never addressed row-internal density, title truncation, or
per-project list length. This plan fills that gap. No new route/destination/nav item.
Confidence: high (grounded in recon screenshots at 1440/1024/390 + full read of
`ActivityOverview.tsx`).

## 0. Scope

`src/mainview/components/ActivityOverview.tsx` only (Dashboard.tsx untouched — it just renders
the component). Narrow viewport (`useNarrowViewport(CAROUSEL_MAX_WIDTH)` = <768px). Desktop
(≥768px / `md:`) behavior stays byte-identical. The earlier narrow pass (kebab→BottomSheet,
≥44px targets, full-width cards) already shipped; this is the density/readability follow-up.

## 1. Feature classification

- User job: at-a-glance triage across all projects — "what needs me right now?" — on a phone.
- Owning surface: Dashboard / Activity overview (a data-visualization + navigation surface, NOT
  a control room). Per the placement rules, durable config does not belong here.
- Feature class: **view-mode / responsive layout refinement** of an existing surface. No new
  actions, no new destinations.
- Frequency: daily. Risk: safe (layout + client-side sort/collapse only).

## 2. Problems observed at 390px (recon)

1. **Task titles truncate to ~15 chars.** The row is a single non-wrapping flex line: dot →
   title(`flex-1`) → bell → status label → time(`w-16`). The right cluster eats a fixed
   ~140–150px, so on 390px the title gets ~190px. The dashboard's core job fails — you can't read
   which task it is. (Violates doctrine §7 "any action/info row: wrap or sheet — never a
   non-wrapping overflow row.")
2. **Project path subtitle is dead weight.** `"/Users/arsenyp/Desktop/src-shared/dev-3.0"`
   truncates mid-path, fills a line, says nothing useful on a phone.
3. **Long scroll.** Rows are already filtered to attention statuses (`user-questions`,
   `review-by-user`, `review-by-colleague`) + custom-column tasks, with background work
   (`in-progress`, `review-by-ai`) collapsed into one summary line — but a project awaiting many
   reviews still emits one row each (base44: 8). Across ~19 projects that is a very long flat list.
4. **Flat priority.** "Your Review" (your action) reads the same weight as colleague "PR Review"
   and informational custom columns ("On Hold").
5. **Kebab sits mid-row**, before the count + chevron, instead of at the true row end.

## 3. Decisions (narrow-only unless noted)

### A. Task row → two-line stack on narrow (THE fix; no viable alternative)
Stack the row on narrow: line 1 = dot + title (`line-clamp-2`); line 2 = status label (colored) +
bell + relative time, indented under the title. Desktop keeps the current single inline row via
`md:` overrides — do **not** duplicate the row markup, switch with responsive classes so the two
layouts can't drift.

Skeleton (preserves desktop exactly):
```tsx
<button className="relative w-full flex items-start md:items-center gap-3 px-4 md:px-5 py-3 md:py-2.5 min-h-[44px] hover:bg-raised-hover transition-colors text-left border-b border-edge last:border-b-0">
  {needsMe && narrow && (
    <span className="absolute left-0 top-0 bottom-0 w-0.5" style={{ backgroundColor: rowColor }} />
  )}
  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5 md:mt-0" style={{ backgroundColor: rowColor }} title={rowLabel} />
  <span className="min-w-0 flex-1 flex flex-col md:flex-row md:items-center gap-0.5 md:gap-3">
    <span className="text-fg-2 text-sm line-clamp-2 md:line-clamp-none md:truncate md:flex-1">
      {getTaskTitle(task)}
    </span>
    <span className="flex items-center gap-2 md:gap-3 flex-shrink-0">
      {bellCounts.has(task.id) && <span className="w-2 h-2 rounded-full bg-accent animate-pulse flex-shrink-0" />}
      <span className="text-xs flex-shrink-0" style={{ color: rowColor }}>{rowLabel}</span>
      {task.movedAt && <span className="text-fg-muted text-xs flex-shrink-0 md:w-16 md:text-right">{timeAgo(task.movedAt, t)}</span>}
    </span>
  </span>
</button>
```
Note: `line-clamp-2 md:line-clamp-none md:truncate` — verify `line-clamp` utilities resolve in
this Tailwind setup (core since 3.3; `truncate` already used here). `needsMe` =
`task.status === "review-by-user" || task.status === "user-questions"`.

### B. Hide the project path/subtitle on narrow
Add `hidden md:block` to BOTH subtitle branches (git `project.path` and virtual
`ops.tileSubtitle`). On narrow the header collapses to icon + name + badge (one clean line); the
name already identifies the project. No new strings.

### C. Kebab → row end; drop redundant chevron on narrow
On narrow, trailing cluster order becomes `[count badge] [kebab]`, kebab LAST. Hide the standalone
`>` nav chevron on narrow (`hidden md:block` on that arrow) — the name button already navigates, so
the chevron is redundant and only competes for the row end. Count stays a small muted badge
(keep it tappable → board, or make it static; either is fine). Desktop unchanged.

### D. Bound the scroll — cap per-project rows on narrow (chosen) + actionable-first sort
On narrow only: render the first `NARROW_ROW_CAP = 3` attention rows; collapse the rest behind a
full-width "show {n} more" button (min-h-44, muted). Per-project expanded state in a
`Set<string>` (component state; no persistence needed — cheap). Desktop shows all rows as today.

Pair with a **narrow-only sort** of `rowTasks` by attention rank so the cap never hides your turn:
`user-questions (0) → review-by-user (1) → review-by-colleague (2) → custom-column (3)`. Desktop
keeps the current array order (sort gated by `narrow`).

Rejected for now (revisit only if still clunky):
- *Per-project accordion (collapse whole project):* extra control + persisted state; many taps to
  fold the long tail. The cap solves the height problem with less chrome.
- *Global "Needs me / All" filter toggle:* adds a persistent dashboard control (against the narrow
  budget of 1 primary action) and hides colleague PR-review some users treat as actionable. The
  actionable-first sort gives most of the benefit with zero new chrome.

### E. Visual priority for "needs me" rows
A 2px left accent strip in the row's status color (`rowColor`) on `review-by-user` +
`user-questions` rows, narrow-only (see skeleton). Subtle — no repaint, reuses the existing status
hex (the sanctioned inline-style exception in `STATUS_COLORS`). Could extend to desktop later;
omitted there to honor "keep desktop intact."

## 4. Tokens & i18n

- Colors: reuse `rowColor` (custom-column color or `statusColors[status]`) — inline-style status
  hex is the documented exception. Chrome stays on tokens (`text-fg-2`, `text-fg-muted`,
  `bg-raised-hover`, `border-edge`, `bg-accent`). No new hex.
- New i18n keys (en/ru/es, `dashboard.ts` domain): `activity.showMoreTasks` (plural, `{count}`),
  `activity.showFewerTasks`. Everything else reuses existing `activity.*` keys.

## 5. Accessibility / responsive

- Touch targets: "show more" and kebab ≥44px; rows already `min-h-[44px]`.
- `line-clamp-2` keeps rows bounded; meta row stays one line.
- `aria-expanded` on the "show more" toggle; it controls the hidden rows.
- Gate every change on `narrow` / `md:`; never on `isElectrobun` or `useMobile`.
- `prefers-reduced-motion`: no new animation introduced (no expand transition required).

## 6. What NOT to do

- No new route, nav item, destination, or "mobile mode" setting.
- No global filter toggle / per-project accordion in this pass.
- Do not touch desktop layout, the BottomSheet action sheet, or reorder logic.
- No native dialogs; no hardcoded strings; no hex outside the status exception.

## 7. Likely files

`src/mainview/components/ActivityOverview.tsx`; `src/mainview/i18n/translations/{en,ru,es}/dashboard.ts`;
tests in `src/mainview/components/__tests__/` (new narrow-layout assertions). Dashboard.tsx
untouched.

## 8. Acceptance

- At 390px: task titles readable (2-line clamp), no row truncates to ~15 chars.
- Header is one line (no path); kebab is the last element; no redundant chevron.
- A project with >3 attention rows shows 3 + "show N more"; your-review/questions sort first and
  carry a left accent strip.
- Desktop (≥768px) pixel-identical to before.
