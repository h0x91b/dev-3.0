Short: Window no longer jumps on portrait screens

On macOS, a dev3 window placed on a secondary screen taller or shorter than the main one (for example a portrait monitor) no longer jumps up the screen every so often; the offscreen check, the saved window position and multi-window restore now read the window's real position on that screen.

Suggested by @noapo-island (h0x91b/dev-3.0#1872)
