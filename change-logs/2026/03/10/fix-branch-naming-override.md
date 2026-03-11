Branch naming convention changed from hardcoded `dev3/` prefix to standard type prefixes (`feat/`, `fix/`, `chore/`, `refactor/`, `docs/`). User preferences from CLAUDE.md, AGENTS.md, or auto-memory now explicitly override these defaults. Worktree cleanup logic updated to track branches by original task name rather than live prefix, so renamed branches are still cleaned up correctly.

Suggested by @AboMokh-Wix (h0x91b/dev-3.0#232)
