Short: Busy terminal screens repaint sooner

Redrawing a full terminal screen used to re-read and re-parse the entire screen once for every row on it, so a 46-row repaint did that work 46 times over. The screen is now read once per frame and sliced per row, which takes about 3.8 ms off every full repaint — the redraws behind scrolling, `vim`, and anything that rewrites the whole screen. Typing a single character is unaffected, because that only repaints a few rows.
