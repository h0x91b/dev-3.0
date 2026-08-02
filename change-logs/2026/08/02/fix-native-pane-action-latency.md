Short: Instant native pane splits and layouts

Splitting a pane or picking a layout on a native-backend task no longer looks frozen for a couple of seconds: the toolbar and the terminal canvas now share one pane state, so the server's answer repaints the panes immediately instead of waiting for the next poll, and the clicked control greys out for the moment the action runs. The ownership probe that verifies each pane's processes also stopped blocking the event loop, cutting a six-pane layout change from 60 ms to 44 ms and a split from 228 ms to 168 ms.
