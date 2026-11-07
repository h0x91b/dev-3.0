Short: Crashed agents no longer look busy

A task whose agent process exits with a non-zero code now leaves "Agent is Working" for Has Questions with an attention badge naming the exit code, for every harness (Codex, Gemini, Cursor Agent, OpenCode, Copilot, Pi) and not only Claude — so a scheduled automation run whose agent dies at startup is visible instead of silently stuck. A clean exit 0 changes nothing, and a stale wrapper from a replaced agent can never move the card.
