Short: Claude accounts stop sharing login state

Managed Claude accounts no longer share per-login runtime state such as identity backups, queued telemetry, the background daemon and MCP auth caches, and stale links to them are removed from existing account folders. Transcripts, history and memory stay shared. New accounts also get their own analytics user and device ids instead of copying the system login's, and a new login no longer starts with the system login's cached org settings.
