Short: Recover terminals after tmux binary swap

On macOS, dev-3.0 now detects when the tmux server behind task terminals runs a tmux from a deleted or different dev-3.0 copy (after an update or a reinstall), which costs every pane its access to Documents, Desktop and Full Disk Access, and offers a confirmed "Restart terminals" action. The notice stays on screen until it is dismissed or used, so it is not missed while the user looks elsewhere after a relaunch.
