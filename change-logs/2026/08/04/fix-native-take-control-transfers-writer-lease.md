Short: Take control now works across windows

Take control in a native terminal now actually transfers the writer lease when another dev3 window or instance holds it, instead of coming back refused and leaving the viewer permanently read-only. The window that had control is told authoritatively that it is now an observer, and the new owner immediately publishes its own pane size as the canonical grid so observers follow it instead of wrapping the output at their own width. Ordinary attaching still never steals the lease, and a host too old to transfer now says so instead of failing silently.
