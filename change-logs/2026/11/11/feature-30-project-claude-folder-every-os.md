Short: Per-project Claude folder on every OS

The "Each project uses its own Claude folder" setting now works on Linux and Windows: a project uses its own .claude there when the .credentials.json login file in it stays out of git (no repo holds the folder, or git ignores the file; dev3 adds the rule to .git/info/exclude at launch), and keeps ~/.claude when that file is tracked. Operations boards always use ~/.claude, and Windows paths in CLAUDE_CONFIG_DIR are normalized.
