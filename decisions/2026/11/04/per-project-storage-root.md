# Per-project storage root

## Context

Every project's board data (`~/.dev3.0/data/<slug>/`) and task dirs (`~/.dev3.0/worktrees/<slug>/`) live in the dev3 home. Some users want each project, or each customer folder, to carry its own dev3 state, with `~/.dev3.0` holding only app-global things (the project registry, settings, agents, sockets, the CLI, logs).

## Decision

`Project.storageRoot = "project"` keeps the board data in `<project>/.dev3/data/` and new task dirs in `<project>/.dev3/worktrees/<shortId>/`. Every path goes through `src/shared/project-storage.ts`; `git.ts taskDir` delegates to `taskDirFor`. Each task stamps `taskDirLocation` at creation, and a stored `worktreePath` wins, so flipping the setting never moves a live task. Tasks with no task dir yet are restamped on a flip. The CLI finds a task from `<P>/.dev3/worktrees/<id>/worktree` by matching that path, and hook and trust checks accept it. Both folders carry a self-ignoring `.gitignore` (`*`), like the board copy.

Switching follows AGENTS.md rule 5: turning it on COPIES `data/<slug>/` into the project and turning it off copies back. Nothing under `~/.dev3.0` is moved, renamed or deleted, and the slug algorithm is untouched.

## Risks

There is no mirror write to the legacy path, because the user asked that no project data stay in `~/.dev3.0`. An older app version opening the shared home therefore shows the board as it was at the switch, and edits it makes there are not merged back. That is accepted, since the switch is opt-in per project. Ignored files are wiped by `git clean -fdx`, so running it in the main checkout deletes the board and task dirs. Nested worktrees inherit from parent folders. Claude Code would also load the main checkout's `CLAUDE.md`, so `writeClaudeHooks` adds those files to `claudeMdExcludes`. The parent `.claude/CLAUDE.md` is left out when that folder holds a `.claude.json`: it is then the session's `CLAUDE_CONFIG_DIR` and the file is the user-level memory, which the worktree has no copy of. The `.claude.json` test relies on where Claude Code keeps its state file, which its docs do not promise. Node resolution can still fall back to `<project>/node_modules`, and tools run in the main checkout that do not read `.gitignore` (test runners with broad globs, file watchers, IDE indexers, cloud sync) walk every task worktree; the toggle's hint says so.

The switch holds the tasks-file locks at both locations while it copies and records the new root, and `src/bun/project-storage-live.ts` sends writes from a `Project` loaded before the switch to the new location; a writer already waiting on the old lock retries on the new one (`withTasksLock`). The CLI is a separate process and does not see that override, so a CLI write racing the switch can still reach the old copy. The copy treats the active side as authoritative: a destination file that differs is saved under `storage-switch-backups/<time>/` before it is replaced, so edits an older version made to the inactive copy are kept for manual recovery rather than merged. Files deleted on one side are not deleted on the other; `tasks.json` decides which per-task files matter.

## Alternatives considered

Pointing `$DEV3_HOME` at another folder moves everything, global state included, and cannot be done per project. A mirror write for older versions would contradict the goal. Symlinking `~/.dev3.0/data/<slug>` into the project would break rule 2: it is an automatic rename under the dev3 home.
