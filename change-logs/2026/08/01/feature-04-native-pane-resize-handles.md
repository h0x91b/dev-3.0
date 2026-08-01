Short: Drag native terminal panes to resize

Native task terminals now show a grab handle on every boundary between panes, so a split can be resized by dragging it instead of guessing at an invisible edge. The handle has a real hit target and cursor, arrow keys step it, double-click recentres it, and the new size is stored with the pane layout so it survives a redraw and an app restart. tmux terminals are unchanged.
