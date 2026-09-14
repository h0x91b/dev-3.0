Short: GitHub Copilot CLI as a harness

GitHub Copilot CLI is now a first-class dev3 harness: it appears in the agent picker with launch presets, resumes the exact session it left, moves its task between board columns through Copilot's own lifecycle hooks, and receives the dev3 protocol out of band so scratch and resumed sessions get it too. Copilot has no event meaning "blocked on the user", so a Copilot task never parks itself in Has Questions on its own.

Suggested by @tomerleib (h0x91b/dev-3.0#1771)
