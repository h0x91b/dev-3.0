# Own worktree for one task in a gitless project

## Context

A project with the git workflow off runs every task in its folder (`decisions/2026/10/02/per-project-git-workflow-switch.md`). When one task needed isolation, for example a parallel platform build on its own branch, a coordinator had to create a git worktree by hand, and dev3 did not track it: no teardown, no Git bar, no diff.

## Investigation

The git workflow switch rejected a per-task coding toggle because columns, review flow and teardown are board-level. Of the roughly fifty `hasGitWorkflow` call sites, about half ask a board question (columns, review, variants, settings, Pull main, PR discovery, conversation import) and half ask a task question (where it runs, teardown, the Git bar, git operations, `dev3 current`, approval wording). Only the task questions need to change for one isolated task.

The local Merge route runs `git checkout` and a squash merge in `project.path`. In a gitless project other agents have uncommitted edits in that folder.

## Decision

- `Task.ownWorktree?: boolean`, a task property like `draft`. It applies only to a git project with the git workflow off whose folder is a repository (`resolveOwnWorktree` in `src/bun/rpc-handlers/task-lifecycle.ts`). It is chosen at creation or while the task is in To Do (`editTask`).
- `taskUsesWorktree(project, task)` in `src/shared/types/project.ts` answers the task questions. `folderWorkDir`, the lifecycle fact `usesWorktrees`, the executor teardown, rehydrate, the PR poll, git operations, branch sync, `dev3 current`, the CLI and in-app approval wording, the inspector Git bar, the reset confirm, and the `.git` check of `assertTaskWorkspacePresent` and the terminal's lost-session screen use it. Board questions keep `hasGitWorkflow`.
- Completion and cancellation teardown in a gitless project uses `branchPolicy: "unique-kept"` (`keepsUniqueBranch` in `src/bun/lifecycle/executor.ts`): there is no PR flow to have landed the branch, so commits found nowhere else survive. The exception is the To Do reset (`resetWorktree` in the same file), which uses `task-owned` as it does in a git project.
- `mergeTask` refuses the local squash in a gitless project (`LOCAL_MERGE_SHARED_FOLDER_ERROR`); the Git bar disables Merge with the reason. Merging an open pull request still works.
- UI: CreateTask's Working folder block becomes a radiogroup, Project folder or Own worktree, offered only when `listBranches` returns branches. Own worktree replaces the path line with the existing `BranchSelector`. CLI parity: `dev3 task create --worktree [--branch <ref>]`.
- The completion and reset dialogs read `TaskDialogSubject.keepsFolder`, built on the bun side, so they no longer guess from the project alone.

## Risks

- An older dev3 ignores `ownWorktree` and runs such a task in the shared folder. A task already holding a worktree keeps its `worktreePath`, so a running one is not moved.
- The base branch for a new branch is `project.defaultBaseBranch`, not whatever the shared folder has checked out.
- Variants, PR review tasks and the AI/PR review columns stay unavailable on a gitless board.

## Alternatives considered

- A toggle in the inspector on a running task: its edits are already mixed into the shared folder and cannot be moved out cleanly.
- A project-wide default of "own worktree": that is the git workflow switched on.
- Adopting a worktree made by hand: dev3 would have to trust a path and branch it did not create. Remove it and create the task on that branch instead.
