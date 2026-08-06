# 184 — Task hibernation is a property, not a runtime phase

## Context

An active task holds a live agent process, a tmux session and often a dev server —
hundreds of megabytes each. Tasks parked in `user-questions` or `review-by-user` can
sit untouched for days while still holding all of it. The only prior options were to
leave it running (pay for unused memory) or complete/cancel it (destroys the worktree
and uncommitted work).

Hibernation kills the agent, the tmux session and the dev server, releases the ports,
and keeps the worktree, branch, uncommitted changes, notes, diff stats, PR state and
the agent's own on-disk transcript. Terminal scrollback is deliberately lost: the
transcript is the state that matters, and preserving scrollback would mean inventing a
storage location, a size cap, a viewer and a cleanup path for it.

## Decision

**Hibernation is `Task.hibernated`, a boolean property of the task record** — the same
class as `Task.draft`. The task keeps its column and its runtime stays `idle`.

- Machine: `hibernateRequested` / `wakeRequested` in `src/bun/lifecycle/machine.ts`,
  derived into `LifecycleFacts.hibernated` by `lifecycleStateFromTask`
  (`src/bun/lifecycle/state.ts`). The freeze reuses existing effects only —
  `clearTaskRuntime`, `destroyTaskPty` (abort), `killDevServer`, `releasePorts`,
  `persistRuntime`. No new effect types.
- Column changes on a hibernated task are refused at the same choke point the draft
  rule uses (`HIBERNATED_TASK_MOVE_ERROR`), so board drag, the status menu,
  automations, scheduled launches and the CLI are covered by one guard. A move to a
  terminal status is the one exception: teardown removes the worktree and takes the
  flag with it.
- Ordering: `taskSortRank` / `compareTaskSortRank` in `src/shared/types.ts` add a fixed
  offset for a hibernated task so it sorts below every live P4, while hibernated tasks
  stay ordered among themselves. `priority` is never written by hibernation.
- Waking reuses the existing recovery screen: `getPtyUrl` reports the frozen state
  instead of auto-restoring, and `resumeTask` / `restartTask` clear the flag.

**No busy-guard, but a confirmation dialog.** Freezing stays one gesture even while the
agent is mid-run — a runaway agent burning CPU is exactly the case where "the agent is
busy" must not be the reason you cannot stop it. It is still confirmed, because killing
the session is the one part hibernation cannot undo: terminal scrollback never comes
back, and extra agent panes return only through `resumeTask`, while `restartTask`
clears `sessionState` and drops them permanently. The dialog therefore leads with what
survives and adds a separate line counting the running agents when `sessionState.panes`
holds more than one.

## Risks

1. **A live agent under a grey card.** Boot deliberately does not reconcile the flag
   against tmux reality. Starting the task's tmux session by hand from a terminal
   leaves the card grey and the wake screen over a live terminal. Costs one extra
   click, and requires going around the app to reach it.
2. **The sink band splits variant groups.** Documented invariant: a variant group never
   spans priority bands. A hibernated variant sinks alone. Intended — the board should
   show honestly how many attempts are still alive.
3. **`idle` now means two things** (never started, and frozen with a worktree),
   disambiguated only by the flag. `runtimeFromTask` carries an explicit guard so the
   "worktree implies running" inference does not fire for a hibernated task.
4. **Older app versions ignore the flag** and can therefore launch a hibernated task.
   The file format stays readable (a new optional field, no path change), but the
   hibernation promise is only kept by versions that understand it.

## Alternatives considered

- **A `hibernated` phase in the runtime union.** Rejected: the runtime is actor-owned
  execution state, and every activity/boot path would have to learn a phase that has no
  work attached. A property is what "parked" actually is.
- **A dedicated column.** Rejected: the board must keep telling the truth about where
  the work is. Parking is orthogonal to the pipeline.
- **Forcing the task to P4.** Rejected: it destroys the user's own judgement of
  importance, so waking would not return the task to its rightful place. A separate
  sink band above priority keeps `priority` untouched.
- **Stashing uncommitted work to a patch to free disk too.** Rejected as a much larger,
  riskier feature; hibernation never removes the worktree.
