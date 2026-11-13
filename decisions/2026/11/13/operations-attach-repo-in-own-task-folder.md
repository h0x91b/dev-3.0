# Operations: a repo inside the task's own folder can be attached

## Context

An Operations agent often creates its own git worktree or clone inside its managed folder `${OPS_DIR}/<slug>/<shortId>/work`, and the user wants to review it from the Git bar. `setTaskAttachedRepo` refused every repo under `OPS_DIR` (`decisions/2026/11/03/operations-attached-repo-read-only-git.md`), because that folder is deleted with the task.

## Decision

`setTaskAttachedRepo` accepts a repo inside the task's own managed folder and refuses one in any other task's folder. `repoPathInOwnTaskFolder` (`src/bun/ops-worktree.ts`) rewrites git's symlink-resolved root onto the folder path as the task stores it, so the pure `isAttachedRepoInTaskFolder` (`src/shared/types/task.ts`) works as a prefix compare in the renderer too. A user-chosen `opsWorkDir` is never deleted and keeps the old rule. Task creation and `inspectOpsFolder` still attach nothing from inside `OPS_DIR`.

When the folder is removed (`removeTaskWorkspace`, i.e. task deletion), a linked worktree inside it would leave a stale entry in its main repo. The executor resolves the main repo first (`git.getMainRepoOfLinkedWorktree`), removes the worktree through git, deletes the folder, then runs `git.pruneWorktrees` there as a safety net. The branch is kept; a plain clone needs nothing; a missing main repo or a failed prune only logs.

A plain Operations task keeps its folder on complete, cancel and reset, but a linked worktree inside it is removed then (Sanya's call), so it is not stranded with a dead Git bar. The `attachedRepoInFolder` fact adds a best-effort `removeAttachedWorktree` effect (after `reapWorktreeProcesses`, before the persist): `git worktree remove --force --force` in the main repo (a locked worktree needs the second flag), and on failure `rm` plus `prune`. Task deletion runs the same removal before it deletes the folder. The branch and the rest of the folder stay. The effect sets a flag that makes the terminal or reset write also clear `attachedRepo`, so there is no separate write to race. A plain clone is never removed, and a repo that is the task folder itself does not count (closing keeps the folder). If the worktree is already gone when the effect runs (a retry or a boot recovery), it only detaches the record. `getUnsavedWork` and the confirm dialogs (completion, reset, agent requests) report and warn only for a linked worktree.

## Risks

`git worktree remove --force` discards uncommitted files, hence the unsaved-work check in the dialogs.

## Alternatives considered

- Store git's resolved path: breaks the prefix compare against `worktreePath` when `OPS_DIR` sits behind a symlink.
- Allow any repo under `OPS_DIR`: lets a task point at another task's folder, which is deleted under it.
