# Board host: how `ctx.board` and the view registry live in Cordis

Partly superseded on 2026-11-01 by `decisions/2026/11/01/kanban-board-view-on-the-contract.md`: the Kanban adapter and `LegacyKanbanBridge` are gone; the contract gained `TaskCard`, column actions and preferences.

## Context

Board views task 1 (spec `board-views-spec.md` §4, the `pluggable-board-views-on-cordis` record) puts
Cordis `4.0.0-rc.11` (exact pin) in the renderer. The host must give views `ctx.board` from the first frame —
the board may not look or act differently — and must survive React StrictMode's mount/unmount/mount.

## Investigation

`Fiber`-backed `ctx.plugin(...)` loads asynchronously, so a service provided through a plugin is absent on
the first render. `ctx.provide(name, value)` and a `Service` constructor both register synchronously on the
providing context's fiber, and the disposer `provide` returns deletes the impl synchronously before its
first `await`, so provide → dispose → provide in one tick works (covered under StrictMode in
`board-views/__tests__/BoardHost.test.tsx`). A service method called through a plugin's context sees that
plugin's context as `this.ctx` (Cordis caller tracking, `symbols.tracker`), so an effect it creates belongs
to the calling plugin. Verified at runtime in Chromium and WebKit 26 from a Vite 8 production build.

## Decision

- `getBoardRoot()` (`src/mainview/board-views/root.ts`) creates the one root `Context` and constructs
  `BoardViewRegistry` (a `Service`) with it, so the registry exists synchronously.
- `BoardService` is a plain class the host provides with `root.provide("board", …)` in a layout effect and
  disposes on unmount; the view renders only after the provision. It reads a `BoardModel` the host rewrites
  every render — a projection of `state.ts`, never a second store. `board/changed` is emitted after commit.
- `BoardViewRegistry.register` wraps the entry in `this.ctx.effect`, i.e. the registering plugin's effect, so
  a disposed plugin's views disappear without cleanup code.
- Until the built-ins register, the host renders the Kanban view component directly; the registered entry
  is the same component type at the same position, so the hand-over keeps state and nothing flashes.
- The board query stays in memory (`useRememberedFilter`), as before: the `query` field of the on-disk
  saved view is written as `""` until named saved views exist, so a fresh launch never opens filtered.
- Both form-factor slots start on one saved view; the first change in one form factor forks a copy
  (`updateActive` in `src/shared/board-view-state.ts`), which keeps view type and layout per form factor.
- Space boards store their file in the new `~/.dev3.0/space-board-views/<spaceId>.json`; the id is
  checked against `[A-Za-z0-9_-]` before it becomes a path.

## Risks

Caller tracking and synchronous `provide` are rc.11 internals, frozen with the pin (D6). The spec named rc.12,
but the Wix npm mirror's cordis metadata stops at rc.11 (rc.12's tarball 404s), so the pin is rc.11; the same
runtime probe passed on both. Moving to rc.12 or 4.0 stable is a deliberate one-line bump that must re-run the
StrictMode and plugin-dispose tests. The temporary `board-views/kanban` adapter and its
`LegacyKanbanBridge` context still feed the old component props the contract does not carry (PR badges,
lineage, bell counts); task 2 removes both.

## Alternatives considered

Providing `board` through `root.plugin(BoardServiceClass)` — async, so a blank first frame or a
fallback without `ctx.board`. A per-board isolated child context — unnecessary while one board is on screen.
Persisting the query — would change behaviour (a restart opening on a hidden-task board).
