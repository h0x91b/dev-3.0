Short: Closing a native pane is instant

Closing a pane on the native terminal backend took about 1.7 seconds: the host asked the shell to stop with SIGTERM, which an interactive shell on a PTY ignores, so every close waited out the full grace window and then force-killed. The host now sends SIGHUP, the hangup a terminal shell actually honours, and a pane closes in about 0.12 seconds with its foreground processes properly reaped.
