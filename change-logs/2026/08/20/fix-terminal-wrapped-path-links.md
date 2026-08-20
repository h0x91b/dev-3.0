Short: File links work on wrapped paths

Terminal file-path links now survive a path that wraps onto the next row, including inside a vertically split tmux window where the terminal never sees a wrap at all. Each pane's columns are stitched on their own, so a link never reaches into the neighbouring pane.
