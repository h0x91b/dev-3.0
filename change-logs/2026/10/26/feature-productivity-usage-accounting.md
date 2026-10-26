Short: Track cost across five agents

Productivity Stats now tracks Claude Code, Codex, Gemini CLI, Cursor Agent through new usage hooks, and GitHub Copilot CLI through saved checkpoints or completed sessions, fixing repeated or missing usage and retaining counted history after log cleanup. Model prices refresh daily in the background while honoring the network opt-out; counters use saved or bundled rates immediately, and unchanged history is not rewritten. Cursor hooks preserve custom configuration and can be removed with `dev3 install-hooks --remove-cursor`; previously deleted logs and older Cursor usage cannot be recovered.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#2064)
