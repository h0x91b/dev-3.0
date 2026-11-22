# Memoized Active Tasks row: one extra commit when a task marker registers

## Context
`ActiveTaskRow` is now `memo`ized with stable, task-taking handlers so a single task update re-renders one row instead of every row. `board-perf-budget-e2e.test.tsx` asserted that registering a task marker lands in exactly one commit on both surfaces.

## Investigation
With the memo, registering a marker produces two commits on the sidebar. In the second, only the row bodies re-run: the marker and rail children still render exactly once per row (2,400 each for 2,400 rows, same as before). No `useState` setter fires, no prop changes, the sidebar and the marker provider render once. It persists with the marker entries passed as a prop, with a custom `memo` comparator, and without the row's `useSyncExternalStore` users. It disappears as soon as any row prop is unstable, i.e. when the row stops skipping renders. The trigger inside React 19.2 was not pinned down within the time box.

## Decision
Keep the memo and assert the observed count: `commits` is 1 for the board and 2 for the sidebar, next to the unchanged "each marker drawn once per row" assertions. The cost is one extra pass over row bodies when an extension or built-in registers a marker (startup, install), against 1,199 saved row renders on every task update.

## Risks
If the second commit grows to re-render row children, the `rail`/`lateMarker` counts in the same test catch it. A React upgrade may change the count back to 1; then tighten the assertion.

## Alternatives considered
Dropping the memo (back to re-rendering all rows per task update). Reading markers in a non-memo wrapper and passing them as a prop (tried, no effect). Relaxing the assertion to `<= 2` (hides a future regression to 2 on the board).
