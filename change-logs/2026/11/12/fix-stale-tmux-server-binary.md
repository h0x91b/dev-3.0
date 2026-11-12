Short: Recover terminals after tmux binary swap

On macOS, dev-3.0 now detects when the tmux server behind task terminals runs a tmux from a deleted, updated-in-place or different dev-3.0 copy, which costs every pane its access to Documents, Desktop and Full Disk Access, and offers a confirmed "Restart terminals" action. The lost-access notice stays on screen until it is used, comes back if the restart is cancelled or fails, and a restart that did not happen is reported as an error.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2236)
