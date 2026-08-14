Short: No more transient task write failures

Task metadata writes no longer fail on transient filesystem hiccups: each atomic write now uses its own temp file (two concurrent writes inside one process used to collide and fail with ENOENT), retries a transient rename a few times, and a timed-out file-lock acquisition is retried with a short deadline instead of failing the whole operation.
