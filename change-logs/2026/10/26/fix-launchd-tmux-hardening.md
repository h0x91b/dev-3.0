Short: Task terminals keep their open-file limit

The macOS tmux server that dev3 starts through launchd now passes the app's open-file limit to task terminals instead of launchd's default of 256. It no longer risks stopping another instance's server, or a server whose socket file was deleted. The job file is written to a private directory, and every `launchctl` call has a timeout. The warning about an older tmux server now also suggests closing every task terminal.
