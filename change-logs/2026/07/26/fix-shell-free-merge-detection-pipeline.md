Short: Merge detection works without bash

Squash and rebase merge detection no longer shells out to `bash -c` for its `git patch-id` pipelines — the two git processes are now streamed into each other directly, so tasks merged on Windows are detected instead of silently reported as unmerged.
