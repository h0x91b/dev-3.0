Short: Each project keeps its own Claude folder

Settings → Agents has a new "Each project uses its own Claude folder" switch: task agents then run with CLAUDE_CONFIG_DIR set to the project's .claude, so its own rules, agents, skills and memory load instead of ~/.claude. dev3 keeps Claude's runtime files and its own skills out of git status, puts its settings entries into the task's local settings instead of a committed settings.json, and conversation search and resume now look in these folders too.
