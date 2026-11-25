# Reclaim out-of-tree state when a task's folder is removed

## Context
Some tools keep per-workspace state outside the workspace, under a name derived from its path. Bazel
keeps one output base at `<output_user_root>/<md5 of the workspace path>/` and never removes it. Every
task worktree that ran a build left 4-14 GB behind after teardown, and nothing reuses it, because no
later worktree has the same path. 17 output bases filled one disk. Deleting the worktree, which dev3
already does, never reaches this state.

## Decision
- **A lifecycle effect, not part of git.** `reclaimOutOfTreeState` runs right after
  `reapWorktreeProcesses` and right before every effect that deletes the task folder: `removeWorktree`,
  `resetWorktree`, and `removeTaskWorkspace`. Hibernation and attached-repo teardown keep the folder, so
  they keep the state too. A preparation failure that keeps its folder (`judgeFailureWorkspace`) skips
  it, like the other teardown effects. `git.ts` stays tool-agnostic.
- **One module, a list of finders** (`out-of-tree-state.ts`). Each finder locates one tool's state while
  the folder still exists and returns how to delete it. Deletion runs in the background, is never
  awaited and never throws, so gigabytes never hold up or fail a teardown. Bazel is the only entry
  today; Xcode DerivedData (`<name>-<hash>`) has the same shape.
- **On by default, not a `cleanupScript`.** A project can already run `bazel clean --expunge` there, but
  nobody adds it until a disk fills. That command also starts a server, and may download Bazel, just to
  delete files.

## Bazel output base
- **Found through the `bazel-out` symlink**, which points at `<output_base>/execroot/<name>/bazel-out`,
  so a custom `--output_user_root` is found too. Bazel only creates that link on a build, so a workspace
  that only ran `query` or `fetch` falls back to the md5 of its path under the default roots
  (`/private/var/tmp`, `~/Library/Caches/bazel`, `~/.cache/bazel`).
- **Guarded by the README.** Its first line is `WORKSPACE: <path>`. The base is deleted only when that
  path is this folder (as written or its real path), so neither lookup can take another workspace's
  output base. Bazel asks programs not to parse that README to reverse-engineer source trees; here it
  is only a safety check.
- **A running server is stopped first**, through `server/server.pid.txt`, but only when that pid's cwd
  is the workspace, because a stale pid file may name a reused pid. The process reaper has usually
  killed it already, since the server runs from the workspace.
- **Directories are made writable before `rm`**, because Bazel leaves read-only directories whose
  entries cannot be unlinked. The walk never follows symlinks, so the shared install base and the
  repository contents cache stay.

## Not covered
- A custom `--output_user_root` with no `bazel-out` link keeps its output base.
- `dev3 doctor --worktrees` does not yet report output bases left before this change.
