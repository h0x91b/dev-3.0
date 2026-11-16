# Opt-in self-completion: `task move --status completed --force`

## Context

A scheduled or delegated task (an automation's daily run, a child a coordinator hands off) often has nobody watching it. It could run unattended up to a merged PR, then sat as a finished card waiting for one click, because completing a task always opened an approval dialog (`decisions/2026/06/15/agent-completion-request.md`). "Done" is also not always a merge: a report task has no PR, another needs several.

## Decision

`dev3 task move --status completed --force` completes the task immediately, with no dialog and no connected window, but only for a task that opted in through `Task.selfCompletion` (`requestDestructiveApproval` in `src/bun/cli-socket/approvals.ts`). Without the opt-in the request is refused and nothing changes. The opt-in is given by someone other than the task: `dev3 task create --self-completion on` (a coordinator creating a child), `Automation.selfCompletion` stamped by `createAutomationTask`, or `dev3 task update --self-completion on` from outside the task. The `task.update` handler refuses a request whose `sourceTaskId` is the task itself. `dev3 current` and `task show` print the state, which is how the task's agent learns it may use the flag. `--force` applies to `completed` only; cancellation and reset still ask.

In the app the opt-in is the third owner behind the existing completion-owner chip in the inspector's Context bar (`TaskInfoPanel.tsx`, `CompletionOwnerMenu.tsx`, `setTaskCompletionOwner`). The chip opens a three-row menu — dev3 suggests / I'll complete it myself / the agent completes it — and picking the agent goes through a danger `confirm()`. It was a click-to-cycle chip in the first draft; review showed the habitual "turn it off" click then landed on the agent state, so no single click may grant it. A grant made by another task's agent raises a toast through the existing `manualCompletionChanged` push. The automation editor gets one form field, "When the work is done" (`AutomationEditModal.tsx`). An agent-owned task also stops raising the post-merge completion prompt (`taskSkipsMergeSuggestion` in `src/shared/types/task-type.ts`), since that popup is what an unattended task must not produce.

## Risks

- A wrong "I'm done" destroys the worktree unreviewed, uncommitted work included. Deliberately no clean-worktree check: the user asked for the opt-in itself to be the whole guard. The diff snapshot and the resumable conversation remain.
- The self-opt-in refusal relies on the CLI reporting its own context; a caller that hides it (a plain shell, a forged param) is treated as the user. It stops an obedient agent, not a hostile process, which already has the user's filesystem.
- The board card carries no marker; the state is visible only in the inspector chip and the automation editor. The New Task dialog has no control either (its manifest rule admits only the Task type picker), so a hand-made task is opted in from the chip after creation.
- Any caller may force-complete an opted-in task, not only the task itself: the opt-in says "this task may be closed without asking", and a coordinator closing its child or the user in a shell are meant to work. Restricting it to the task's own agent was considered in review and left out for that reason.
- The refusal text and help deliberately name who can grant the opt-in and never the command, so an agent following them asks the user instead of stepping outside its worktree to grant itself.
- The protocol body has no room for a sentence about it (`agent-command-line-budget.test.ts`); the `dev3 current` line carries it instead.

## Alternatives considered

- **Auto-complete when dev3 can prove the PR merged.** Rejected: many of these tasks have no PR or several, so the agent has to be the one saying "done".
- **A bare `--force` any caller may pass.** Rejected: the dialog would stop protecting ordinary tasks from their own agent.
- **A global setting instead of a per-task opt-in.** Rejected: one switch would open every task; the per-task flag keeps the choice explicit and travels with automations.
- **A timer that approves the completion dialog,** as launches have. Still rejected for the reason in `decisions/2026/08/22/auto-approve-agent-launch-requests.md`: silence is not consent. An explicit opt-in is.
