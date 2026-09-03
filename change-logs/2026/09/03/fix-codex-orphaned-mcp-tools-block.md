Short: Codex tasks no longer die on stale MCP approvals

Fixed Codex tasks failing to launch with "invalid transport" when a per-theme dev3 profile still held an approval table for an MCP server that had left the config; dev3 now prunes those orphaned `mcp_servers.*` entries at startup and before every Codex spawn.

Suggested by @OrenZak (h0x91b/dev-3.0#1640)
