Short: Terminal columns match other terminals

Terminal cell width is now quantized on the device pixel grid the way native Ghostty does it, instead of being rounded up in CSS pixels: at font size 16 JetBrains Mono goes from 10 px to Ghostty's 9.5 px per column on a 2x display. The old rounding also let two bundled fonts (Hack and Meslo LG S) render wider than the reference font at sizes 15, 20, 25 and 30 in the desktop app, and made the desktop app and remote browser mode disagree on the column count for the same font — both are fixed. Font list, font sizes, the picker and zoom are unchanged.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1668)
