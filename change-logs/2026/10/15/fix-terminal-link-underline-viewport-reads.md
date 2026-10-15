Short: Lighter terminal link underlines while output streams

Terminal link underlines no longer copy the whole screen out of the terminal emulator once per row: each repaint now reads the screen once for both file-path and dev3:// links, which in a 221×70 pane cut the overlay from ~23 ms to ~0.8 ms per frame while an agent streams output. Bidi rendering also stops re-reading the cursor's row on idle frames when nothing on it changed.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1962)
