# 047 — Compact Empty Kanban Columns on Narrow Viewports

## Context

On narrow viewports (laptops, sub-1440px windows) the Kanban board's fixed 17.5rem columns push interesting work off-screen because empty columns claim the same width as full ones. Users asked for empty columns to shrink, but the constraints were tricky: hover-to-expand on every mouse pass would jitter the layout on scroll, and expansion during a task drag would shift the entire board mid-drop.

## Decision

Added a "compact-narrow" render path inside `KanbanColumn.tsx`:

- A column is compact when `useNarrowViewport(1400)` is true, `tasks.length === 0`, the column is not the Todo column (which always shows "+ New Task"), and is not in the existing fully-collapsed vertical state.
- Width is a fixed `w-[6.125rem]` (~35% of the standard 17.5rem). A fixed width keeps all empty columns visually aligned — content-driven widths produced uneven gaps that looked sloppy. The title relies on the existing `truncate` Tailwind class to fall back to `text-overflow: ellipsis`.
- All header chrome (rename / info / collapse / drag-handle) is unmounted in compact-narrow mode; only the color dot + truncated label remain visible.
- Hover expansion is gated by a 300ms `setTimeout` dwell (`compactDwellTimer`) — accidental cursor passes while scrolling do not trigger expansion. Mouse leave clears the timer and resets the state.
- When `dragFromStatus` or `dragFromCustomColumnId` becomes non-null, an effect cancels the dwell timer and force-collapses any in-flight expansion, so dropping into the narrow strip never causes the board to shift.
- After a drop, `tasks.length > 0` removes the column from the compact path and it renders at the normal 17.5rem width naturally.

New hook: `src/mainview/hooks/useNarrowViewport.ts` — reactive `window.matchMedia` wrapper.

## Risks

- The 1400px threshold is hardcoded. If the app gains an explicit "compact mode" setting later, this should switch to a user preference.
- Drop targeting works on the narrow strip because all drag handlers stay on the root `<div>`, but the visual target is smaller than before — power users on laptops may need to aim more carefully. Mitigation: the existing border-accent highlight stays prominent and fills the entire compact column.
- `useNarrowViewport` listens to `matchMedia('change')`. Older WebKit needs `addListener` instead of `addEventListener`, but Electrobun ships a modern WebKit so this isn't a concern in production. Test setup mocks both APIs.

## Alternatives considered

- **Floating overlay** that expands over neighbors without layout shift — rejected because it overlaps the adjacent column and confuses drop targeting.
- **Click-to-expand instead of hover** — rejected because the user explicitly asked for hover behavior. Dwell + drag-disable solves the jitter problem.
- **Pure CSS `:hover` width transition** — rejected because it would expand on accidental cursor passes during scroll and during drag-over, exactly the failure mode the user called out.
- **Content-driven width** (`max-content` clamped between min/max) — tried first, rejected because empty columns ended up at slightly different widths depending on title length ("AI Review" vs "Has Questions"), which looked uneven.
