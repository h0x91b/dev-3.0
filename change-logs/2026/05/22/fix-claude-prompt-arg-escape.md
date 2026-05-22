Fixed agent CLIs (claude, codex, gemini, cursor) crashing with `error: unknown option '---…'` when a task description starts with `---` (markdown frontmatter or horizontal rule). We now emit `--` before the positional prompt so the agent's argument parser stops scanning for options.

Suggested by @Capibara- (h0x91b/dev-3.0#570)
