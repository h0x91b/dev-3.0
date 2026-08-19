Short: Terminals stop dying after a resume

A terminal pane no longer breaks — blank canvas, output frozen until restart — after the app has been in the background for a while. The screen reset that clears pixels inherited from a previous terminal now runs once when the terminal is built, instead of on every socket reconnect, which is what corrupted the renderer's state during a resume.
