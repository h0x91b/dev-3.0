# Revealing the selected sidebar row after a status-driven reorder

## Context

The left task list groups tasks into readiness tiers (`groupTasksIntoTiers`), so a task that
starts working leaves NEEDS YOU and lands at the bottom of WAITING. The scroll position never
moved with it: the user typed into an idle task, the agent started, and the still-selected row
silently left the viewport.

## Investigation

Driving the running app showed two things a naive `scrollIntoView` would have got wrong. The
tier headers are `sticky top-0`, so `block: "nearest"` tucks the row under a header; and
`scrollIntoView` walks up the ancestors, which here means the page and the terminal pane.

Measured in the browser, a single scroll assignment is also not enough: right after a task
opens, the rest of the list has not laid out yet, so the browser clamps `scrollTop` and the
row ends up 22 px short, then drifts further as rows arrive.

## Decision

`src/mainview/hooks/useRevealSelectedRow.ts`, wired into `ActiveTasksSidebar` with
`data-task-id` on each row wrapper and `data-sidebar-tier` / `data-sidebar-tier-header` on the
tier block. It writes the container's own `scrollTop` (never `scrollIntoView`), never touches
focus, and fires only when the selected row's position key — task id, tier, index — changes.

Three rules keep it out of the way:

- A row the user had already scrolled away from stays where it is. A `scroll` listener records
  whether the selected row was on screen; selecting another task overrides that, because
  picking a task is an explicit request to see it.
- After the first scroll the reveal keeps following the row frame by frame for up to a second,
  which is what defeats the clamp described above. It stops as soon as the row is fully visible.
- `wheel` / `touchstart` / `pointerdown` / `keydown` on the list cancel the whole thing. A
  programmatic scroll must not count as the user taking over, which is why the follow loop
  ignores `scrollTop` moving under it and watches for input events instead.

## Risks

The follow loop can scroll for up to a second after a reorder; if the list keeps reflowing for
longer, the reveal gives up rather than chasing it forever. The `scroll` listener measures the
selected row on every scroll event — three `getBoundingClientRect` calls, passive.

## Alternatives considered

`scrollIntoView({ block: "nearest" })`, as used by `TaskSwitcherOverlay` and `GlobalHeader`:
rejected because it scrolls ancestors (page, terminal) and knows nothing about the sticky tier
header. A `ResizeObserver` on the list instead of the frame loop: nothing in the sidebar is a
single content wrapper to observe, and it would fire long after the reveal is over.
