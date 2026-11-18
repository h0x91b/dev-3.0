Short: Codex asks before dev3 pane run

Sandboxed Codex agents now ask you before running dev3 subcommands that start a process — `dev3 pane run`, `dev-server start`, `agent spawn` and the like — instead of letting the app run them outside the sandbox unasked; dev3 writes these rules into its own `rules/dev3.rules` file and never touches your Codex rules. This guards against an agent bypassing its sandbox by accident, not against a deliberate one.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2043)
