Short: Never type into a booting agent

dev3 no longer types a peer-launch handoff note, a queued message, or any other automatic input into an agent that has not finished starting up, so its Enter can no longer confirm Claude Code's workspace-trust dialog (whose default is "No, exit") and kill the agent dev3 just launched. Claude now reports session start and end through a readiness-only hook, each receipt is tied to the exact pane and launch it came from, and a scheduled message arriving mid-startup waits in its queue instead of being dropped. Readiness fails closed on purpose: if the `dev3` CLI in `~/.dev3.0/bin` is older than the running app it cannot prove which launch a receipt belongs to, and messages to a freshly launched task are refused until the two match — the app installs its own CLI there at every start, and Claude prints the mismatch in the session.

Suggested by @80summers-code (h0x91b/dev-3.0#1785)
