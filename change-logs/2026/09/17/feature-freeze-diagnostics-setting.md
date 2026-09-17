Short: Freeze recording is now a setting

Recording local macOS freeze diagnostics moved from the DEV3_DEBUG=1 environment variable to a switch in Settings → System → Advanced Experience, so it works the same whether the app was opened from Finder, the Dock or a terminal. It is off by default, takes effect immediately in both directions without a restart, keeps the same local-only bounds, and says plainly when the machine cannot be recorded.
