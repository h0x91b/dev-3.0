# 080 — CLI task-context resolution falls back to DEV3_TASK_ID

## Context

The dev3 CLI resolves its `(projectId, taskId)` context from the current working
directory: git worktrees match `~/.dev3.0/worktrees/<slug>/<task>/worktree`, and
managed Operations tasks match `~/.dev3.0/ops/<slug>/<task>/work`. But two kinds
of virtual ("Operations") task run *outside* that tree: a fixed-folder operation
(user-picked `opsWorkDir`, e.g. `~/Downloads`) and the built-in **Quick shell**
(runs in `homedir()`). For those, path detection returns `null`, so the agent
status hooks (`dev3 task move --status in-progress --if-status-not …`) silently
no-opped — the board never advanced through its lifecycle.

## Decision

`detectContext` gained a third resolver, `resolveFromEnv()` in
`src/cli/context.ts`, that reads the `DEV3_TASK_ID` env var the app already
injects into every task tmux pane (`buildAgentEnv` / `tmux-pty.ts`) and scans all
projects (git + virtual) for the owning project. Order is
`worktree || virtualPath || env` — **path wins over env** so a user who `cd`s
between worktrees in one pane resolves the dir they are actually in; env is the
fallback only when no path matches.

## Risks

- The env var reflects the pane's task, not the cwd. With path detection taking
  precedence this is safe, but a future caller that bypasses `detectContext` and
  trusts `DEV3_TASK_ID` blindly could mis-resolve after a `cd`.
- **Test isolation gotcha:** tests that assert `detectContext(<non-dev3-path>)`
  returns `null` now break when run inside a real dev3 agent pane (where
  `DEV3_TASK_ID` is set). Affected CLI test files clear it in `beforeEach`
  (`context.test.ts`, `context-virtual.test.ts`). Any new test asserting "no
  context" must do the same.

## Alternatives considered

- **Broaden the ops path marker** to also match fixed-folder/Quick-shell dirs —
  impossible, those dirs are arbitrary user paths with no shared prefix.
- **Write a marker file into the work dir** — adds on-disk state and litters
  user-chosen folders; the env var is already present and free.
