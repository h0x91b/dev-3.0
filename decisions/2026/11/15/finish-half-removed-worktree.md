# Finish a worktree git left half removed, or report it with its own exit code

## Context

`git worktree remove --force` deletes the checkout itself and stops at the first error. On a large untracked tree (a 1.4 GB `.venv`) it failed with "Directory not empty" after it had already deleted the `.git` link: git no longer considered the folder a worktree, gigabytes stayed on disk, the teardown aborted and the task stayed in its column (h0x91b/dev-3.0#2269). A second completion succeeded only because the "`.git` does not exist" validation error is already treated as "unregistered, delete the folder".

## Decision

`removeWorktree` (`src/bun/git.ts`) treats a failed remove whose `.git` link is gone (`isHalfRemovedWorktree`, `src/bun/worktree-leftover.ts`) like the unregistered case: a dev3-managed task folder is deleted with a few spaced retries, since whatever made git fail may still be writing, then pruned. A folder outside dev3's task folders is never deleted; it, and a managed folder that still cannot be removed, raise `WorktreeHalfRemovedError`, whose message names the folder and how to finish.

The lifecycle passes only an error's message through its `reject` effect, so `requestDestructiveApproval` (`src/bun/cli-socket/approvals.ts`) reads the half-removed state off disk when the move fails, and rethrows with `cliReason`. The CLI socket forwards it as `CliResponse.reason`, and `dev3 task move` maps it to `CLI_EXIT_CODE_WORKTREE_HALF_REMOVED` (48).

## Risks

The disk probe says "half removed" for any move failure while the folder exists without `.git`, whatever the real cause; that state is accurate either way, and re-running the move finishes it. An older CLI talking to a newer app ignores `reason` and exits 1 with the same message, which is still non-zero.

## Alternatives considered

Carrying the error class through the lifecycle machine would touch every compensating event for one failure. Returning `approved: true` with a flag in `data` would make an older CLI print "approved" and exit 0, which is the bug being fixed.
