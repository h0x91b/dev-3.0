Short: Streamer mode hides private info

Added Streamer mode (Settings → Appearance, or the ⇧⌘P command palette) — a privacy toggle for screen recordings and screenshots that blurs identity-bearing values across the UI: agent account emails and names, organizations/workspaces, home-folder paths, tunnel URLs, the remote-access QR code, and GitHub logins. Terminal content is not masked. A `?streamer=on` URL parameter forces it in remote/browser mode, so QA agents take every screenshot masked by default.
