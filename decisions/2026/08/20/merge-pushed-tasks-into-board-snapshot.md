# Merge pushed task updates into the board snapshot instead of dropping it

## Context

`ProjectView` fetches the project's tasks on mount / project change. PR #1144 added a guard
(`taskUpdateEpochRef`) that skipped the whole `setTasks` dispatch if any `rpc:taskUpdated` push for
that project arrived while the fetch was in flight — protecting a freshly pushed scheduled task from
being overwritten by an older disk snapshot.

## Investigation

User report plus `~/.dev3.0/logs/2026/08/2026-08-20.log`: switching from a task in project A to a task
in project B fires `getTasks` for B (2 ms) while the same tick writes a task update for the task being
opened. `navigate` had already cleared `currentProjectTasks` (different project), the epoch guard threw
the 1697-task snapshot away, and the `updateTask` push appended exactly one task. The board then showed
a single card, and never refetched because `ProjectView` stays mounted while the split task view is open —
only a dashboard round trip (remount) recovered it. The log confirms no `getTasks` fires when leaving the
task via the breadcrumb.

## Decision

`src/mainview/components/ProjectView.tsx` now collects pushed tasks for the project into
`inFlightTaskUpdatesRef` (a `Map<taskId, Task>`, cleared when a fetch starts) and overlays them onto the
snapshot when it lands: pushed versions win per id, pushed tasks missing from the snapshot are appended.
The dispatch always happens, so the board can never end up with a partial list.

## Risks

A task deleted between fetch start and resolve would be re-added if its update push arrived in that
window — the same hole the previous guard had, and `removeTask` pushes clear it immediately.

## Alternatives considered

Keep the guard and schedule a refetch when it fires (extra round trip, still a window of wrong data);
drop the guard entirely (reintroduces the #1144 scheduled-launch regression).
