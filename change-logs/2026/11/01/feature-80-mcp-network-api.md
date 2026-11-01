Short: MCP network API for outside agents

`dev3 mcp` serves MCP over HTTP on a loopback listener (off by default) so an agent on another machine, through `tailscale serve` or `ssh -L`, can read the board with a scoped, expiring per-sender token issued by `dev3 mcp token issue`. `dev3 task create`, `task update` and `task move` also gain `--json`.
