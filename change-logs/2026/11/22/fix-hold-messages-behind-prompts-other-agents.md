Short: Messages wait behind other agents' prompts

`dev3 message`s now also wait while a Codex approval or blocking question, a Copilot `ask_user` question, an omp tool approval, a pi extension prompt or an Antigravity approval is on screen, and arrive once it is answered. A Claude tool call that fails no longer leaves a later permission menu waiting for it. Cursor, Gemini CLI and OpenCode have no hooks and stay unprotected.
