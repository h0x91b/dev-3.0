Short: Finished tasks free their Bazel cache

Tearing down a task worktree now also deletes state that tools keep outside it under a path-derived name, starting with the Bazel output base, so finished tasks no longer leave gigabytes of build output behind.
