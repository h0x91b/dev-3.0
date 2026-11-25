Short: Cleanup scripts run again

Project cleanup scripts had stopped running because the tmux client that shows them started without TERM and exited at once. The attached client now always gets TERM, LANG and HOME, so cleanup scripts run as intended. A failing cleanup script now shows an error toast and leaves a task note with its exit code and last output.
