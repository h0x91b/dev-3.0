Reduce terminal flickering when viewing running tasks by adding PTY data batching (~60fps instead of per-byte forwarding), terminal write batching via requestAnimationFrame on the renderer side, improved reconnection (clear screen before injecting captured pane), and optimized tmux config with synchronized output (DEC 2026), extended keys, focus events, RGB terminal overrides, and 250k scrollback buffer. These changes dramatically reduce WS message count and ghostty-web render passes during high-output AI agent sessions.

Suggested by @AboMokh-Wix (h0x91b/dev-3.0#234)
