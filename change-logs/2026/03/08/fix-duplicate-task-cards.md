Fix race condition where creating a new task briefly shows duplicate cards. Added ID deduplication check in the `addTask` reducer so a task that already exists in state is not appended again.
