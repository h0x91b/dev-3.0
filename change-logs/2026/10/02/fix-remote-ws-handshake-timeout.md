Short: Remote boot no longer hangs on Connecting

A remote browser whose RPC WebSocket handshake never completes no longer sits on "Connecting to your computer..." until you press Retry: the stalled socket is replaced after 10 seconds and the app loads on its own.
