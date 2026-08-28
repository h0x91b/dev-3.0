# Imported conversations get a worktree, not an agent

## Context

Importing a recent Claude Code conversation must land the task in **Has Questions**
with a worktree and a branch, so the work is there to be picked up. The obvious
route — `createTask` with `status: "user-questions"` — goes through the lifecycle
machine, and a move into an active status calls `prepareTask` → `git.createWorktree`
→ `launchTaskPty`. Importing twelve conversations would boot twelve agents nobody
asked for.

## Investigation

`needsActivation` fires only when a task moves from a non-active status into an
active one. A task **created** directly in `user-questions` is already active, so
nothing re-activates it later; opening it launches a fresh PTY that receives the
description as its first prompt. That is exactly the behaviour the feature wants.

## Decision

`importConversationsHandler` (`src/bun/rpc-handlers/conversation-import-handlers.ts`)
writes the task with `data.addTask` and then calls `git.createWorktree` itself,
persisting `worktreePath`/`branchName` with `data.updateTask`. No lifecycle event,
no terminal, no agent. A worktree that cannot be created is reported in
`problems[]` and the task is kept anyway — the description is the valuable part.

## Risks

- **`setupScript` does not run at import.** It lives inside `launchTaskPty`, which
  import deliberately skips. The first launch of the task runs it as usual, so the
  worktree is un-set-up until then.
- A second `createWorktree` on an existing worktree would destroy it
  (`reclaimStaleWorktreeDir`). Import is idempotent per session id precisely so
  this cannot happen twice for one conversation.

## Alternatives considered

- **`createTask` + lifecycle**: rejected, boots an agent per conversation.
- **Import with no worktree at all, create it on first open**: rejected, the branch
  the conversation ran on may be gone by then, and story 12 wants the branch
  derived from the conversation.
