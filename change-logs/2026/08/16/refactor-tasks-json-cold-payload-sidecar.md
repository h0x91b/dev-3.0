Short: Task storage shrinks by up to 64%

Task storage no longer carries a per-file diff breakdown that nothing read, and writes tasks.json without indentation, so boards load and save faster on large projects. The archived breakdown moves to a per-task sidecar file rather than being deleted, and the file stays readable by older app versions.
