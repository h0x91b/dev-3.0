Short: Green pane runs close themselves

A command an agent ran in a neighbouring pane (`dev3 pane run` — builds, test runs) no longer parks the pane at "press Enter to close" once it succeeds: a run that exits 0 closes its own pane after 10 seconds. A run that failed or was killed still keeps its pane open until you dismiss it, because that output is what you came to read.
