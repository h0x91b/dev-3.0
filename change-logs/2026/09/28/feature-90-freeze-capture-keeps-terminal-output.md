Short: Freeze captures keep recent terminal output

With "Record app freezes (macOS)" on, a capture triggered by a window that stopped responding now also saves the latest terminal output each pane was sent, pinned from the moment heartbeats went stale, so a renderer stuck inside a terminal write can be replayed offline. The file stays local (0600, at most 4 MiB, rotated with its session), and the switch's description now says it holds terminal output.
