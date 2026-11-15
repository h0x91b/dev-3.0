# Start after: a conditional launch beside "Start in"

> Amended on 2026-11-13 by `decisions/2026/11/13/task-dependencies-on-relations.md`: the cycle check is no longer a walk over `launchAfter` alone. A start-after prerequisite counts as a task dependency, and one shared check covers both links.

## Context

Stacked work (one PR built on another, a backlog a coordinator orders by hand) needs "start B when A is done". Before this change a person or a coordinator had to watch `dev3 events` and run the launch. dev3 already had a one-shot timed launch (`Task.scheduledLaunch`, fired by `src/bun/scheduled-launch-scheduler.ts`); this adds a condition next to the time.

## Investigation

- Older builds parse `tasks.json` whole and write tasks back with `{ ...task, ...updates }` (`src/bun/data.ts`, `rawLoadTasks` / `updateTask`), so an unknown field survives their rewrites. An older build simply never fires the condition; it cannot fire it early because the field is separate from `scheduledLaunch.at`.
- The PR poller already persists `prStatusCache.mergeState.state` and `pullRequests[].state` (`persistPrStatus` in `src/bun/lifecycle/executor.ts`) while the prerequisite's session runs, so "merged" needs no new GitHub traffic in the common case.

## Decision

- New optional field `Task.launchAfter` (`LaunchAfter` in `src/shared/types/agent-launch.ts`): prerequisite id and seq, `until: completed | merged`, an optional agent variant, the arming agent, and the arm time.
- `src/bun/launch-after.ts` runs inside the existing 30 s scheduled-launch tick on the task list that tick already read. The condition is cleared under the tasks-file lock (`updateTaskWith`, matched on `armedAt`) before the launch, so it fires exactly once even with two app builds running. The claim also re-checks that the task is still in To Do: a task the user started by hand after the tick's read only loses its stale condition.
- Trust matches `dev3 task move --status in-progress`: armed from a terminal outside any task, it starts directly (`moveTask` with `explicitLaunch`, or `launchTaskWithAgentChoice` with `--agent`). Armed from inside a task, the start goes through `requestAgentLaunchApproval` with that task as the requester, so the user's auto-approve setting applies and a declined start stays in To Do. Arming must never become a way around the launch dialog. The launched agent gets the usual "report back" handoff only while the arming task is still live; by the time a condition holds, the arming task has usually finished.
- "Merged" reads the persisted PR state. Only when the prerequisite is already Completed with a PR whose merge was never seen does the tick ask GitHub, at most once per 5 minutes per waiting task (`getPullRequestSnapshot`, which caches MERGED). Probes run in the background, at most four at a time across boards, and the tick never awaits them: after a restart, a burst of probes (15 s deadline each) must not delay the "Start in" launches of the same tick. A probe re-checks the condition through the same claim, so a late answer cannot fire a re-armed or started task.
- The prerequisite is the whole variant group: any variant that completes (or whose PR merges) satisfies the wait, and it is abandoned only when no variant can. Variants share the source's seq, so a deleted source still finds its siblings. A PR number not yet recorded as `prNumber` is read from the poller's cache or the task's PR records.
- A cancelled or deleted prerequisite, a PR closed without merging, or a Completed prerequisite with no PR (for `merged`) clears the condition, writes a "Did not start: ..." reason to `preparationError` (`startAfterAbandonedMessage` in `src/shared/preparation-failure.ts`, which the card recognizes and shows translated, without the "Launch failed" prefix), and lights attention. Self-references, cycles, drafts, non-To-Do tasks, tasks with a "Start in" time and a prerequisite that is already finished (completed, or its PR already merged for `merged`) are refused at arm time; the tick still probes GitHub for a prerequisite completed after arming. `task create --start-after` checks the prerequisite before the task exists (`prerequisiteRefusal`), so a refused create leaves nothing behind.
- On the board it is set in the launch modal's **Launch later…** panel as a third mode beside In / At (**After task**: a picker of the open tasks on the same board, completes / PR merges, the agent from the variant row; `StartAfterPicker.tsx`, `setTaskLaunchAfter`). It takes one variant, because the condition stores one. The card chip shares the deferred-timer slot with "Start in" (they never coexist) and opens the same popover: **Start now** (`startTaskLaunchAfterNow`, a person's direct start) and **Remove start condition** (`clearTaskLaunchAfter`). A To Do card's context menu carries **Start after…**, which opens the same dialog already on After task, or **Remove start condition** when one is set. Completed and merged differ in icon and label. The CLI and the board share `armLaunchAfter` in `src/bun/launch-after.ts`. Placement: `docs/ux/UX_DECISIONS.md` 2026-11-07.

## Risks

- While the prerequisite has no live session, its PR is not polled; a merge after completion is then found by the 5-minute probe, not within one tick.
- An agent-armed start opens a dialog when it fires, which may be hours later. With auto-approve off it waits for the user, the same as an agent's direct launch request.

## Alternatives considered

- Reusing `scheduledLaunch` with a sentinel time: an older build would fire it at the sentinel. Rejected.
- Event-driven firing on the prerequisite's status change: faster, but misses changes made while the app was down and needs hooks in the lifecycle executor. The tick already gives restart catch-up for free.
- Orca's full task graph (runs, dispatches, gates): far more than the one need the board shows.
