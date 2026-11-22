Short: Cursor tools run after switching

Fix Cursor Agent blocking every tool call with an invalid JSON hook error after switching from Claude Code. Refresh inherited dev3 pre-tool hooks on Cursor launch and return a valid response even when the app is offline, while retaining Claude's normal permission checks.
