Make generated Codex lifecycle hooks treat `dev3` exit code 2 ("app not running") as a non-blocking no-op, so prompt submission, Bash tool execution, and Stop still work when the desktop app is closed. The fallback is selective: other CLI failures still surface instead of being hidden.

Suggested by @AboMokh-Wix (h0x91b/dev-3.0#443)
