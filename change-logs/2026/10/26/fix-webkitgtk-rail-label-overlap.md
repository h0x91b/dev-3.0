Short: Readable task rail labels on Linux

The vertical status word on task cards and Active Tasks rows (WORKING, REVIEW, DONE…) no longer renders as overlapping letters on Linux: WebKitGTK stepped upright vertical text by each glyph's horizontal width, so the rail now stacks one character per line instead of relying on vertical writing mode. Spaces in custom column names and multi-codepoint characters (accents, emoji) each keep their own line, and the label looks the same as before on macOS, Windows and in the browser.

Suggested by @elygoncalves (h0x91b/dev-3.0#2040)
