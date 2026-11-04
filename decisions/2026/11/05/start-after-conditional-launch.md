# Start after: a conditional launch beside "Start in"

## Context

Stacked work (one PR built on another, a backlog a coordinator orders by hand) needs "start B when A is done". Before this change a person or a coordinator had to watch `dev3 events` and run the launch. dev3 already had a one-shot timed launch (`Task.scheduledLaunch`, fired by `src/bun/scheduled-launch-scheduler.ts`); this adds a condition next to the time.

## Investigation

- Older builds parse `tasks.json` whole and write tasks back with `{ ...task, ...updates }` (`src/bun/data.ts`, `rawLoadTasks` / `updateTask`), so an unknown field survives their rewrites. An older build simply never fires the condition; it cannot fire it early because the field is separate from `scheduledLaunch.at`.
- The PR poller already persists `prStatusCache.mergeState.state` and `pullRequests[].state` (`persistPrStatus` in `src/bun/lifecycle/executor.ts`) while the prerequisite's session runs, so "merged" needs no new GitHub traffic in the common case.

## Decision

- New optional field `Task.launchAfter` (`LaunchAfter` in `src/shared/types/agent-launch.ts`): prerequisite id and seq, `until: completed | merged`, an optional agent variant, the arming agent, and the arm time.
- `src/bun/launch-after.ts` runs inside the existing 30 s scheduled-launch tick on the task list that tick already read. The condition is cleared under the tasks-file lock (`updateTaskWith`, matched on `armedAt`) before the launch, so it fires exactly once even with two app builds running.
- Trust matches `dev3 task move --status in-progress`: armed from a terminal outside any task, it starts directly (`moveTask` with `explicitLaunch`, or `launchTaskWithAgentChoice` with `--agent`). Armed from inside a task, the start goes through `requestAgentLaunchApproval` with that task as the requester, so the user's auto-approve setting applies and a declined start stays in To Do. Arming must never become a way around the launch dialog.
- "Merged" reads the persisted PR state. Only when the prerequisite is already Completed with a PR whose merge was never seen does the tick ask GitHub, at most once per 5 minutes per waiting task (`getPullRequestSnapshot`, which caches MERGED).
- A cancelled or deleted prerequisite, a PR closed without merging, or a Completed prerequisite with no PR (for `merged`) clears the condition, writes the reason to `preparationError`, and lights attention. Self-references, cycles, drafts, non-To-Do tasks and tasks with a "Start in" time are refused at arm time.
- UI is a read-only chip on the card. Setting it is CLI-only (`task create|update --start-after`); a UI control waits for a `/ux-principal` pass.

## Risks

- While the prerequisite has no live session, its PR is not polled; a merge after completion is then found by the 5-minute probe, not within one tick.
- An agent-armed start opens a dialog when it fires, which may be hours later. With auto-approve off it waits for the user, the same as an agent's direct launch request.

## Alternatives considered

- Reusing `scheduledLaunch` with a sentinel time: an older build would fire it at the sentinel. Rejected.
- Event-driven firing on the prerequisite's status change: faster, but misses changes made while the app was down and needs hooks in the lifecycle executor. The tick already gives restart catch-up for free.
- Orca's full task graph (runs, dispatches, gates): far more than the one need the board shows.
