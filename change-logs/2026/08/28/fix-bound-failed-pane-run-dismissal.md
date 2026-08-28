Short: Failed panes also close themselves

A pane run that failed no longer waits for Enter forever — it closes itself after 30 minutes, long enough to read the output and short enough that dead panes stop piling up, while a successful run still goes after 10 seconds. The dev3 skill now states closing finished panes as the agent's own duty rather than something the timer handles for it.
