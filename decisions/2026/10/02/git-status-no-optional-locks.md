# dev3's `git status` runs with `--no-optional-locks`

## Context

Agents and users hit `fatal: Unable to create '.git/index.lock': File exists` while dev3 polls their repos in the background. In Git 2.55 (`builtin/commit.c`, `cmd_status`) `git status` takes `index.lock` after refreshing the index and holds it through `wt_status_collect`, the whole tracked and untracked scan, only to cache refreshed stat data. A concurrent `git add`/`commit`/`checkout` in that window fails. `--no-optional-locks` (equivalent to `GIT_OPTIONAL_LOCKS=0`, Git 2.15+) skips exactly that lock. Required locks taken by writes are untouched.

## Investigation

In Git 2.55 only `git status` checks `use_optional_locks()`. Porcelain `git diff` against the worktree (`refresh_index_quietly`) and `git describe --dirty` lock the index when they find stat-only changes, and the flag does not stop that. Disposable-repo measurements (20 000 files, a reader in a loop and 60 `git add` in parallel, 3 runs): plain `git status` failed 19–25 writes, `git --no-optional-locks status` failed 0, `git diff --numstat HEAD` failed 2–4. Porcelain output was byte-identical with and without the flag. `-c diff.autoRefreshIndex=false` stops the diff lock, but it changes results: with `--find-copies`, a stat-dirty file becomes a copy source, and a new file counted as +40 lines counted as 0.

## Decision

`withGitDefaults` in `src/bun/git.ts` is the argv decorator shared by `run`, `runGitStdinBinary` and `runGitPipe`. It finds the subcommand after the global options and prepends `--no-optional-locks` only when the subcommand is `status`. Every `git status` dev3 runs is a read where the write-back is only a cache, so no call site opts in or out. All other commands are left alone, and no environment variable is set process-wide. `git --no-optional-locks` exports `GIT_OPTIONAL_LOCKS=0` to its children, so putting it on writes would reach the user's hooks. Tests: `src/bun/__tests__/git-optional-locks.test.ts`.

## Risks

dev3's status polls no longer refresh the stat cache, so stat-dirty files are re-hashed until some other git command writes the index. The `git diff` refresh then happens in dev3's diff polls: a short lock once per stat-dirty event, not one for every status. It is still a residual cause. Git older than 2.15 would reject the flag, and `isWorktreeDirty` would read that failure as "clean". dev3 already needs Git 2.38 (`merge-tree --write-tree`). Not run on Windows. The flag is the same in Git for Windows, but lock failures there also come from antivirus and open handles.

## Alternatives considered

- Process-wide `GIT_OPTIONAL_LOCKS=0`: would leak into agent shells, tmux and user hooks.
- Flag on every git call: has no effect outside `status`, and it reaches write commands' hooks through the environment.
- Opt-in per call site: the next `git status` added would forget it.
- `diff.autoRefreshIndex=false` or plumbing `diff-index` for background diffs: rejected, see the measured output change above.
