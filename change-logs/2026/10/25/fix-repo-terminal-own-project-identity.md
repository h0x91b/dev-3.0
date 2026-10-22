Short: Repo terminal shows its own project

The Repo terminal no longer shows another task's number and project name (for example `#14 video-edit` in the base44 Repo terminal) in its prompt, in new splits and in new windows, and `dev3` commands typed there no longer route to that unrelated task: it now carries its own project's name and path and clears every task-scoped variable, and a task terminal no longer leaves its identity in the shared tmux server's global environment for others to inherit.
