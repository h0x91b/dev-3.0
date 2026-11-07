# Operations tasks: an attached repo gives read-only git

## Context

Operations (virtual) tasks had the whole git domain hidden. Sometimes the user wants a one-off session with a repository (see its diff, review it) without adding a permanent project to the board.

## Decision

`Task.attachedRepo` (repo top level) is a separate field from `opsWorkDir`/`worktreePath`: the agent's working folder and the reviewed repo may differ (the agent can make its own worktree, or the repo is attached to a task that already runs). It is set automatically when the chosen working folder is inside a repo, or later from the Git bar (`setTaskAttachedRepo`). One resolver in `rpc-handlers/git-operations.ts` maps a task to its git context for READ handlers (diff, branch status, unsaved work); `assertGitTask` still rejects every write (commit-via-agent, rebase, push, PR, merge) for virtual tasks. Branch status for an attached repo is local facts only — no `gh`, PR status or merge detection.

Worktree mode (`Task.opsWorktree`, an opt-in checkbox at creation, off by default so picking a repo folder keeps meaning "work in this folder") runs `git worktree add -b dev3/task-<id>` under the managed ops dir and behaves like a git task there: the repo's `.dev3` config applies (`rootProjectFor` / `resolveLaunchProject` in `src/bun/ops-worktree.ts`), reset/complete/cancel remove the worktree and keep the branch, after the usual unsaved-work check. A removal with no recorded path keeps the dir when `git status` is dirty or fails. In attached-only mode the repo's setup/cleanup scripts never run. A repo inside `OPS_DIR` is never attached (`isInsideOpsDir` in `src/bun/ops-worktree.ts`, compared against `OPS_DIR` both as written and resolved, since git reports roots with symlinks resolved): that dir is deleted with its task. Agents may still run `dev3 pr create`; `dev3 pr watch` rejects Operations tasks because the PR poller only walks git projects.

## Risks

Merge and rebase assume two directories (the task worktree and the project checkout holding the base); an attached repo has one, where the agent works, so they cannot run there without switching branches under the agent. Push/PR would work but were left out because the user does not need them.

## Alternatives considered

- An ephemeral hidden git project: full features for free, but it writes into `projects.json`, which older app versions would show as an ordinary project, and needs hiding on every surface. Rejected.
- Treating `opsWorkDir` itself as the repo: cannot attach to an already running task without changing its cwd. Rejected.
