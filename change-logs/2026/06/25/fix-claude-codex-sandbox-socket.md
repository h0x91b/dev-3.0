Fixed the dev3 CLI falsely reporting "app not running" inside sandboxed agents. dev3 now auto-allowlists the sockets directory in Claude Code's sandbox (~/.claude/settings.json sandbox.network.allowUnixSockets), migrates Codex's config to the new [permissions.*.network.unix_sockets] map form that codex >= 0.119 actually reads (the old allow_unix_sockets array was silently ignored), and the CLI now explains a blocked connection points at the sandbox instead of a stopped app.

Suggested by @banuni (h0x91b/dev-3.0#726)
