Short: Closing a pane no longer kills the terminal

Closing one pane of a native task's terminal used to replace the whole terminal with the "session ended" screen when the pane happened to be the one the task was launched with, hiding panes whose agents were still running. The task's terminal now reports itself over only when its last pane closes.
