# Jittered, bounded backoff for transient `git worktree add` contention

## Context
`git worktree add -b` writes the new branch's upstream into the shared `.git/config`, taking `config.lock`. Launches that start together, or any other git process writing config meanwhile, make the loser exit after it already created the branch (and sometimes half of its `[branch]` section). #1605 added three fixed retries (200/500/1200 ms).

## Investigation
Measured through the real `createWorktree` on disposable repos: bursts of 8–48 simultaneous launches lost nothing with the old retry, but with 4–6 processes looping `git config` writes it lost 10 of 480 launches, every one to `could not lock config file` after the third retry. Fixed delays also wake colliding launches together. A second transient shape turned up: every worktree-listing git command dies with `failed to read .git/worktrees/<name>/commondir` while a sibling add has written `gitdir` but not yet `commondir` (reproduced deterministically with a hand-made metadata dir). A `git branch -D` of the leftover branch can itself lose a ref lock, after which `add -b` fails permanently with "already exists".

## Decision
`worktreeAddWithRetry` in `src/bun/git.ts`: up to 8 attempts inside a 12 s budget, delay = exponential ceiling 150 ms → 2 s with equal jitter (`gitLockRetryDelayMs`). It retries only `isTransientWorktreeAddFailure` (config/ref lock "File exists", sibling commondir race); anything else returns on the first failure. A round whose leftover branch survives `branch -D` waits instead of re-adding. On exhaustion the stderr gains "gave up after N attempts over Xs". Nothing ever deletes a lock file or prunes another worktree's metadata; after these failures the task's own directory does not exist, so the reclaim's `worktree prune` does not run.

## Risks
A permanently stale `*.lock` or a broken sibling metadata dir now costs up to ~12 s before the same error surfaces. Only dev3-owned branches (task/variant branches the failed attempt itself created) are ever deleted between attempts.

## Alternatives considered
An in-process mutex around worktree creation: does not help against other processes (agents renaming branches, a second app instance) and serializes every launch. Creating branches with `--no-track`: removes the config write but changes upstream behaviour other code relies on. Reducing other config writers (compare-ref `branch --set-upstream-to`, first `sparse-checkout init`): out of scope, inventoried in the task report.
