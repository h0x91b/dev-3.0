Short: Keep dev3 data inside the project

Project Settings can now keep a project's board data and new task worktrees inside the project folder (`.dev3/data`, `.dev3/worktrees`) instead of `~/.dev3.0`, which keeps only app-global state. Switching copies the data and never deletes it; running tasks stay where they are. The lean agent protocol is now also a global Settings toggle, in addition to `DEV3_LEAN_PROTOCOL=1`.
