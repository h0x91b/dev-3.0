Short: GitHub Copilot CLI as a harness

GitHub Copilot CLI is now a first-class dev3 harness: it appears in the agent picker with launch presets, resumes the exact session it left, moves its task between board columns through Copilot's own lifecycle hooks, and receives the dev3 protocol out of band so scratch and resumed sessions get it too. It parks itself in Has Questions whenever Copilot asks you something, trusts its own worktree so the first launch does not stop on a folder-trust prompt, and pre-approves the dev3 CLI so a status move is never held up by a permission question.

Suggested by @tomerleib (h0x91b/dev-3.0#1771)
