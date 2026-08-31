Short: Artifacts can no longer freeze the app

On macOS the artifact viewer now renders the report in its own webview process instead of an iframe, so an artifact that wedges its own main thread no longer takes the whole dev-3.0 window with it — the app stays responsive and you can close the report. Remote mode, Linux and Windows keep the previous iframe path.

The local Electrobun webview-tag reference in vendor-docs was also corrected against the shipped 1.18.1 code: it documented four things that do not hold, each of which fails silently.
