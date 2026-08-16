Short: Task storage shrinks by two thirds

Task storage no longer carries a per-file diff breakdown that nothing read, keeps each task's title/overview history in a per-task sidecar file, and writes tasks.json without indentation — a large board's store drops by up to 68%, so it loads and saves faster. Nothing is deleted and the file stays readable by older app versions. A task now also keeps its 50 most recent notes, so one long-running agent can no longer grow a single card's note list without bound.
