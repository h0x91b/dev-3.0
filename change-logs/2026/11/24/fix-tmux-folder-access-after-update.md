Short: Terminals keep folder access after updates

On macOS 27 an app update could silently cut task terminals off from Documents, Desktop and Full Disk Access, because the tmux server kept running a file the update had deleted. The server now runs from a hardlinked copy of the app under the data folder that updates never delete; a server that still runs a deleted tmux gets the "Restart terminals" notice again, and `dev3 doctor` shows which file the server runs and whether a protected project folder is readable.

Contributed by @mcaldas (h0x91b/dev-3.0#2440)
