Short: Startup requests no longer vanish

Fixed the desktop app occasionally starting on default settings or a board stuck loading: requests sent before the app's internal connection opened could be silently dropped, so they now wait for that connection, and a remote browser whose server could not keep up gets reconnected instead of left waiting forever. Startup loads of settings, agent presets, sort order and tips now retry and show up in Diagnostics when they fail instead of failing silently.
