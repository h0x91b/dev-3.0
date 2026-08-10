Short: Reviewed branches no longer run their own scripts

A task started on a remote or fork ref — a pull request you opened for review — no longer runs that branch's committed `.dev3` setup, dev and cleanup scripts, no longer exports its env vars into your sessions, and no longer gets pre-granted agent trust or `.mcp.json` approval; the project's own config is used instead. Such tasks carry an eye marker on the board and a "Code: someone else's" row in the inspector, where one click hands the branch its trust back after a warning. In the diff viewer, a changed `.dev3/config.json`, `.mcp.json` or `.claude/settings.json` now wears a RUNS badge so a hostile command cannot hide in a large review.

Reported by @glmgbj233 (h0x91b/dev-3.0#1315)
