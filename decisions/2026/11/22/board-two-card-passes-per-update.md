# Board: two card passes per task update, left in place

## Context
After `TaskCard` was memoized (PR #2419), the real app still runs the `BoardTaskCard` wrapper twice per task update (4,400 wrapper renders for 2,200 cards), which earlier read as "BoardHost renders 2-3 times". Measured with render counters on a seeded 2,400-task board: `BoardHost` itself renders once per rename (twice for a status move).

## Investigation
Pass 1: `BoardHost` rebuilds `BoardCardBindings` (new maps, `lineageFor`), so every `BoardTaskCard` (a `BoardCardBindingsContext` consumer) re-renders. Pass 2: the host's `useEffect` emits `board/changed`, `useBoard()` in the view bumps, and the columns render their cards again.

## Decision
Leave both passes. Pass 1 is the only route by which bell counts, ports, dev servers and resource usage reach cards: they are not part of the board model, so `board/changed` does not fire for them. Merging the passes means either putting those into the model or changing when `board/changed` fires, and `ctx.board` is a public extension API (`EXTENSION_API_VERSION`). With the memo, both passes cost only the thin wrapper plus a props compare; the `TaskCard` body runs for changed cards only.

## Risks
A view that renders many cards and is not memo-friendly still pays twice. Revisit if a profile shows the wrapper passes in a long task.

## Alternatives considered
Stable bindings read through a ref (breaks bell/port updates). Emitting `board/changed` from a layout effect (same two renders, one commit earlier). Folding the per-task maps into `BoardModel` (API change, out of scope).
