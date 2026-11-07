# Missing start branch: a shared message contract, not a new error field

## Context

A To Do task can start from an existing branch (`task.existingBranch`). If that branch is deleted before the task starts, usually because its pull request merged, `git worktree add <path> <branch>` fails with `fatal: invalid reference: <branch>` and `createWorktree` passed that stderr to the user as is. The project default-branch path already had its own check; the existing-branch path had none.

## Decision

`createWorktree` (`src/bun/git.ts`, existing-branch path) runs `resolveRef` only after `git worktree add` has failed, and throws `startBranchMissingMessage(branch)` when the ref no longer resolves. The happy path pays no extra git call. The message is built and recognised by one module, `src/shared/preparation-failure.ts`, the same pattern as `src/shared/launch-failure.ts`. The renderer (`utils/preparationFailureMessage.ts`) swaps a recognised message for the `task.startBranchMissing` translation in the toast and on the To Do card. Every other error passes through unchanged. The advice is "start a new task from another branch" because a non-draft task has no way to change its start branch: the To Do detail dialog has no Branch field, and neither `dev3 task update` nor any RPC sets `existingBranch` after creation.

## Risks

The contract is the English text: rewording `startBranchMissingMessage` without its regex breaks recognition. Both live in the same module and a round-trip test covers them. Tasks that failed before this change keep their old raw `preparationError` until they fail again.

## Alternatives considered

A structured `preparationErrorKind` field on the task and on the `taskPreparationFailed` push. That is more robust, but it adds a persisted field to `tasks.json` and every place that clears `preparationError`, for one message. An automatic fallback to the project default branch was rejected as silent: the user chose that branch on purpose. An explicit "start from the default branch" action is a separate UX decision.
