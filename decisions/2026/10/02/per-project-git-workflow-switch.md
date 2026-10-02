# Per-project git workflow switch

## Context

Architecture, discovery and documentation work lives in one folder that several tasks touch over weeks, and most of it never becomes a PR. A worktree per task, a branch, a diff bar and review columns are dead weight there. Operations boards (`decisions/2026/06/24/virtual-operations-board-identity.md`) already ran tasks without git, but only in a synthetic project with managed temp folders: no real project folder, no `.dev3/` config, so no per-project env or agent account.

## Investigation

The virtual board hides the git domain through about a hundred inline `project.kind === "virtual"` checks. They answer two different questions: "does this project have a git workflow" (columns, Git bar, merge watch, worktree teardown) and "is this a synthetic board" (separate `virtual-projects.json`, no config files, no project terminal). Only the first question applies to a real folder with git switched off.

Three teardown steps act on the task's folder by path and would have damaged a shared folder: `reapWorktreeProcesses` kills every process whose cwd is inside it, `runCleanupScript` runs a script written for a throwaway checkout, and `removeTaskWorkspace` sends any non-virtual path to `git.removeWorktree`. The reaper already hit virtual tasks in a chosen folder (Quick-shell in `~`). `conversation-handoff.ts` and `artifact-template.ts` derived the task container from `dirname(worktreePath)`, which is the parent of a shared folder.

## Decision

- `Project.gitWorkflow?: boolean` in `projects.json`, absent means on. `hasGitWorkflow(project)` in `src/shared/types.ts` is false for virtual boards and for `gitWorkflow: false`; every git-domain check uses it, identity checks keep `kind`.
- A gitless task runs in `project.path` (`folderWorkDir` in `src/bun/task-folder.ts`), resolves the folder's `.dev3/` config, and skips setup and cleanup scripts. Completion clears `worktreePath` like a git task.
- The lifecycle fact `projectKind` became `usesWorktrees: boolean`.
- Teardown only reaps processes in a folder the task owns (`taskOwnedFolder` in `src/bun/lifecycle/executor.ts`), `git.removeWorktree` refuses the project folder itself, and MCP pre-approval skips the project folder (`src/bun/agents.ts`).
- The switch is refused while any task holds a folder or is preparing or tearing down (`gitWorkflowSwitchBlocker`), and switching on needs a git repository. `addProject` accepts a non-git folder only with `gitWorkflow: false`.
- `dev3 current` prints `Git workflow: off` and `Folder:` so the agent does not plan branch or PR steps.

## Risks

- Tasks share one folder, so two live agents can edit the same file. The create dialog warns when another task is live there; variants are not offered.
- An older dev3 reading `projects.json` ignores the flag and treats the project as git. For a git folder it would offer worktrees again; for a plain folder its git calls fail and log. Nothing is renamed or migrated, so it degrades without data loss.
- The handoff preview still picks the newest transcript in the folder, which can belong to a neighbouring task.
- dev3's status hooks and Bash permissions are merged into the folder's `.claude/settings.local.json`, as for any task folder, and stay there after the task ends.
- The CLI's own approval prompts (`dev3 task move --status completed|cancelled`) still describe a worktree being destroyed. The in-app dialogs say the folder is kept.

## Alternatives considered

- A per-task coding / non-coding toggle: columns, review flow and teardown are board-level, and one board mixing both would need every surface to branch per task.
- Storing gitless projects in `virtual-projects.json`: their data slug would change on every switch and orphan the tasks.
- A virtual board with a default folder: it keeps no `.dev3/` config, so the per-project agent account cannot follow it.
