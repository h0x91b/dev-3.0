Short: Remote terminals notice when they die

A terminal that exited kept looking alive in a browser or on a phone: the desktop app announced the death to its own windows only, so the remote view sat on a bare `[exited]` with no "Terminal session ended" screen until a reload. Nine events were affected in all — terminal deaths, port and dev-server updates, resource and rate-limit readings, and update prompts — and every push in the desktop entry now goes to attached browsers as well, guarded by a test so a new one cannot forget.
