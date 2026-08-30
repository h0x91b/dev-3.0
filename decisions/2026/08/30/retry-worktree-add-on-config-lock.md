# Retry `git worktree add` on config-lock contention

## Context

Starting a task with several variants runs several `git worktree add` against the
same repository at once. Each one writes the new branch's upstream config into the
shared `.git/config`, so the losers of the `config.lock` race die with
`error: could not lock config file .git/config: File exists` /
`error: unable to write upstream branch configuration`, and the task bounces back
to To Do.

## Investigation

Reproduced by holding `.git/config.lock` and running
`git worktree add -b dev3/task-xxxx ../wt origin/main`: git exits 255 **after the
branch already exists** — modern git spawns `git branch` as a child before it
creates the worktree directory, and `install_branch_config` failing there is fatal.
A naive retry therefore fails with "a branch named … already exists".

## Decision

`worktreeAddWithRetry` in `src/bun/git.ts` wraps all five `git worktree add` call
sites in `createWorktree`. It retries only on lock contention
(`isGitLockContention`: `could not lock config file`, or any `*.lock … File exists`)
with a 200/500/1200 ms backoff, and before each retry re-runs
`reclaimStaleWorktreeDir` plus a `git branch -D` of the branch **that attempt
created** — never a branch that already existed, which is why the caller passes the
branch name explicitly instead of the helper guessing it.

## Risks

Three retries add up to ~1.9 s to a genuinely stuck start (a stale `config.lock`
nobody owns). Retrying an add that already checked something out is prevented by
matching stderr, not by exit code.

## Alternatives considered

A repo-wide mutex around worktree creation would serialize variants and remove the
race entirely, but it only covers dev3's own processes — the user's shell, an agent,
or another dev3 install can hold `config.lock` just the same. Retrying handles both.
