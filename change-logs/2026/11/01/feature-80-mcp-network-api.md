Short: MCP network API for outside agents

`dev3 mcp` serves MCP over HTTP on a loopback listener (off by default) so an agent on another machine, reached through `tailscale serve` or `ssh -L`, can read the board, message tasks, create and start tasks through the approval dialog, and (opt-in) peek and search transcripts, each with a scoped, expiring per-sender token from `dev3 mcp token issue`. `dev3 task create`, `task update` and `task move` also gain `--json`.

Suggested by @mcaldas (h0x91b/dev-3.0#2066)
