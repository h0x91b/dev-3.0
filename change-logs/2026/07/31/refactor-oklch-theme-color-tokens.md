Short: Rebuilt both theme palettes

Rebuilt the dark and light colour tokens in OKLCH: the muted text ladder is now readable (dark tertiary/muted text went from APCA Lc 35/19 to 61/41), surface lightness ramps are monotonic so modals sit above cards and hovers never dip below the surface they lift from, dark borders got a visible step, and the four warm roles (warning, gold, awake, fire) are separated by hue instead of overlapping. Accent hover split into `--accent-hover` for fills and `--accent-emphasis` for text, so hovering a link no longer lowers its contrast on dark.
