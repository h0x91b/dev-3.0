Fix worktree creation crash when base branch does not exist (e.g., repo with no remote or misconfigured default branch). `getDefaultBranch()` no longer blindly returns "master" — it verifies the branch exists and falls back to the first available local branch. `createWorktree()` now validates the base ref before calling `git worktree add`, producing a clear error message instead of a raw git error. Added comprehensive tests for all edge cases: no-remote repos, master-only repos, empty repos, and branch mismatch scenarios.

Suggested by @alonfrishberg52 (h0x91b/dev-3.0#213)
