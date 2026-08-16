Short: Stop no-op task updates freezing the app

A task update that changes nothing no longer rewrites the project's tasks.json, and the Codex pane-session hook answers its steady-state no-op from cache instead of taking the file lock. On a large board an active Codex agent was rewriting a 14 MB tasks.json around eleven times a second, which pinned the main process event loop and froze the UI.
