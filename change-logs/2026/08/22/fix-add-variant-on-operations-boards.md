Short: Add variant works on Operations

The Launch task dialog now offers "+ Add variant" on Operations (non-git) boards instead of
silently leaving the slot empty. The old guard assumed parallel operations would clobber a
shared folder, but each variant is its own task and gets its own work dir, so they never
collided.
