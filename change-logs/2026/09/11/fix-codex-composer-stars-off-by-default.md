Short: Codex composer stars off by default

Codex draws decorative "Astra composer stars" behind the input and repaints them every 150ms for as long as the composer is visible, so an idle pane streams around 187 KB every 20 seconds for nothing. dev3 now seeds `tui.whimsy = false` into `~/.codex/config.toml` — written once when the key is absent, so anyone who sets it back to `true` keeps the stars.
