Short: Per-project Claude folder on Linux and Windows

The "Each project uses its own Claude folder" setting now works on Linux and Windows: a project uses its own .claude there when git ignores the .credentials.json login file in it (dev3 adds the rule to .git/info/exclude), and keeps ~/.claude when that file is tracked. Operations boards always use ~/.claude, and Windows paths in CLAUDE_CONFIG_DIR are normalized.
