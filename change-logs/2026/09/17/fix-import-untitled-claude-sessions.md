Short: Import sessions Claude never titled

Bulk conversation import no longer skips Claude Code sessions that carry no `ai-title` record — desktop-app sessions and plenty of CLI ones never get one, and all of them were silently invisible on the import list. A session now counts as importable when a human actually spoke in it, and a missing title falls back to the first request, exactly as Codex rows already did.
