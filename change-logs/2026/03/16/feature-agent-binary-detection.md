Agent binary detection: the app now checks whether each agent CLI (Claude, Codex, Gemini, Cursor Agent) is installed and shows the status in Global Settings with green/red badges. Missing agents display install commands with a copy button and a custom path input. When launching a task with a missing agent, a friendly error page with retry support replaces the cryptic "exit code 127". Resolved binary paths are auto-saved to settings so the app finds agents even with minimal PATH in the .app bundle.

Suggested by @arsenyp (h0x91b/dev-3.0#342)
