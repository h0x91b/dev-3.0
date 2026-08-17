Short: Parse agent conversations into JSON

dev3 can now parse a task's Claude Code and Codex transcripts into one canonical event model (messages, reasoning, tool calls and their results, token usage, fidelity warnings) and write them as JSON via `dev3 conversations dump`. Dumps land in the task's own `conversations/` folder next to its logs and diffs, survive worktree teardown, and are re-derivable caches — the native transcript stays the source of truth. First step toward conversation import and cross-agent handoff.
