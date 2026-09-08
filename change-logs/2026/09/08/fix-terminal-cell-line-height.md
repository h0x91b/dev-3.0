Short: Terminal lines get their real spacing

Terminal rows are now spaced the way the font was designed to be set, instead of being derived from the ink of a capital "M" plus a guess: at font size 16 JetBrains Mono goes from 17 px to its designed 21 px, so descenders no longer touch the next line and the terminal matches Ghostty, Terminal.app, iTerm2 and VS Code at the same nominal size. Cell width is unchanged.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1668)
