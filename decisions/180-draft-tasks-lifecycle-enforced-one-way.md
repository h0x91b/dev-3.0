# 180 — Draft tasks: enforced in the lifecycle machine, and one-way

## Context

"Save as draft" (issue #1158) parks an unfinished task in To Do with a guarantee
that **nothing** can start it: not the Run button, not a board drag, not a
scheduled launch, not an automation, not `dev3 task move` from an agent. Two
choices in that design will look arbitrary later, so they are recorded here.

## Decision

**1. The block lives in the lifecycle machine, not in the UI.** `Task.draft` is
derived into `LifecycleFacts.draft` (`src/bun/lifecycle/state.ts`), and
`moveTransition` (`src/bun/lifecycle/machine.ts`) rejects the move the moment
`needsActivation && facts.draft`. Every activation path in the app funnels
through that one `moveRequested` event, so one guard covers all of them —
including paths added later, which get the rule for free. The hidden Run button,
the non-droppable card and the CLI's dedicated exit code are cosmetic mirrors of
a rule that already holds server-side. `scheduleTaskLaunch` repeats the refusal
because it persists a *future* activation rather than dispatching one, so it does
not pass through the machine.

**2. draft → ready is one-way.** `editTask` refuses `draft: true` on a task that
is not already a draft, and there is no demote affordance in the UI, RPC or CLI.
A task the user has already started reasoning about (possibly launched, possibly
with notes and an overview) must not be able to slide back into "not ready" —
that would make "is this runnable?" a question with a moving answer, and every
consumer (scheduler, automations, agents) would have to re-check it.

## Risks

- The single choke point is only as good as the funnel: a future feature that
  activates a task *without* dispatching `moveRequested` would bypass the rule.
  That funnel is already the project's central invariant (see the task lifecycle
  glossary in `AGENTS.md`), so the risk is accepted rather than mitigated.
- `DRAFT_TASK_ACTIVATION_ERROR` (`src/shared/types.ts`) is matched as a string by
  the CLI to pick exit code 9. It is therefore a contract, not log text — hence
  the shared constant instead of an inline message.

## Alternatives considered

- **Guard in each caller** (Run button, drag handler, scheduler, CLI): rejected —
  five places to keep in sync, and the sixth one added next year is the bug.
- **A separate `draft` status/column**: rejected — it would change how the To Do
  column is composed, and every consumer of `TaskStatus` would need a new case.
  A draft is a *property* of a To Do task, not a lifecycle phase.
- **Allow demotion, guarded by "only while never launched"**: rejected as a rule
  whose precondition ("never launched") is itself derived state that drifts.
