# Treat a lost `.git` link as an already-removed worktree

## Context

A user reported the same four log lines at every app start: `Removing worktree` →
`git exit128: fatal: validation failed, cannot remove working tree: '<path>/.git' does not exist`
→ `Failed to remove worktree` → `Lifecycle effect failed: event=bootObserved effect=removeWorktree
policy=abort`. The task behind it had been stuck for thirteen days.

## Investigation

The task record still carried `runtimeState.runtime === "tearing-down"`. On boot,
`rehydrateTaskLifecycles` dispatches `bootObserved`; the `tearing-down` branch of
`bootTransition` (`src/bun/lifecycle/machine.ts`) sees `worktreeExists === true` and re-runs the
whole teardown chain, `removeWorktree` included, with `onError: "abort"`.

On disk the worktree directory existed but held no `.git` — only leftover agent config. Git kept
the registration and marked it `prunable`; `git worktree remove --force` refuses such a path
permanently, `--force --force` included. `isUnregisteredWorktreeError` in `src/bun/git.ts` did not
match that wording, so the effect threw, the chain aborted before `persistTerminalTask`, the
compensating `teardownFailed` left the runtime untouched, and the next boot repeated it. The loop
is self-sustaining: nothing in it can ever change the condition it fails on. Each pass also re-ran
`runCleanupScript` and `reapWorktreeProcesses` for that task.

Reproduced in a scratch repo: deleting `<worktree>/.git` yields that exact `fatal:` line, and
`git worktree prune` afterwards clears the registration while leaving the directory and its branch
intact.

## Decision

`isUnregisteredWorktreeError` (`src/bun/git.ts`) now also matches
`cannot remove working tree:.*does not exist`, routing it into the existing "git no longer has a
working tree here" branch: warn, remove the directory when it is a dev3-managed task worktree,
`git worktree prune`, then delete the branch as usual. The match is deliberately narrow — a locked
or dirty worktree reports different wording and still rejects, which
`src/bun/__tests__/git-worktree.test.ts` guards in both directions.

## Risks

The recovery deletes whatever residual files sit in the managed task directory. That is the policy
the sibling "unregistered" case already applies, and it only fires during a terminal teardown the
user asked for. A genuinely unsafe failure (locked worktree, refused removal) still aborts the
chain — and still wedges the task in `tearing-down` across boots, which this change does not
address.

## Alternatives considered

Prune the registration but leave the directory: avoids deleting anything, at the cost of an orphan
directory under `~/.dev3.0/worktrees/` that nothing will ever reclaim. Bounding the boot retry in
the lifecycle machine instead: broader, and it would paper over the misclassification rather than
fix it.
