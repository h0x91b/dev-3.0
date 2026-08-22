Short: Merge commits get a real subject

Merging a task now takes its commit subject from the branch's own commits — reused verbatim when the branch has a single commit — or from the task title, instead of the first 80 characters of the task description with a trailing ellipsis. A scratch placeholder, an already-truncated title, or a title with a newline never reaches the subject, and nothing is ever truncated.
