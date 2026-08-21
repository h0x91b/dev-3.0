Short: Open a task from the CLI

`dev3 task open [<id>]` brings the app to the front on a task — the CLI twin of a `dev3://task/<id>` link, but it needs no registered URL scheme, so it works on every platform. Without an id it targets the current worktree's task, it honors the split-vs-fullscreen open-mode preference, and it reopens a window when the app is sitting window-less in the dock.

Suggested by @sworgkh (h0x91b/dev-3.0#632)
