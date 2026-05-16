Clicking a watched-task notification now jumps straight into that task. When a watched task changes status and you click the system notification, dev-3.0 comes to the front and opens the task — no more hunting for it on the board.

Implementation uses a window-focus heuristic instead of a notification click callback (which Electrobun does not expose). See decision 049 for the trade-offs.
