Short: No stale screen on task switch

Opening a task in remote mode no longer shows the previous task's terminal output: a fresh ghostty terminal inherited the screen the previous one held, and over a tunnel that leftover stayed on display for as long as the redraw took. The canvas is now cleared on attach, and in remote mode it sits behind a blur labelled "Syncing terminal..." until the session's own output arrives.
