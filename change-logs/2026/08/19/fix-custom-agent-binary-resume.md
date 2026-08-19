Short: Custom agent binaries resume properly

An agent pointed at a custom executable — a wrapper script, a shell alias, a renamed build of Claude Code — is now handled as the CLI it actually is, so Resume Session continues the conversation instead of restarting from the task description. Settings → Agents gained "Which CLI is this" (the old "Lifecycle Hooks" field, widened to cover launch flags, session resume and the dev3 protocol as well), and setting a Custom path on a built-in agent no longer makes dev3 forget which agent it is.
