Short: dev3 pr create works from a fork

`dev3 pr create` now pushes to your fork when origin is not writable (or to the remote git is set to push to), opens the pull request against origin with your fork as the head, and subscribes the task's agent to the merge so it is woken to request completion instead of the task sitting open after the PR lands.
