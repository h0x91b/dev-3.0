Short: File links work on wrapped paths

Terminal file-path links now survive a path that wraps onto the next row — a real soft wrap, a vertically split tmux window where the terminal never sees a wrap at all, and an agent CLI that reflows its own output into indented continuation rows. Each pane's columns are stitched on their own, so a link never reaches into the neighbouring pane, and a row that was stitched by mistake still keeps the links it holds on its own.
