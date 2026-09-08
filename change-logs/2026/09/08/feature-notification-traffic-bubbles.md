Short: Notification history on the traffic timeline

Recorded `dev3 notify` calls can now be read back and shown as semantic bubbles — green for success, blue for info, red for error — with the level, the delivery mode and whether the notification actually reached you. A new read API serves the archive newest-first with its real date range, a filesystem watcher picks up rows another running instance wrote, and rows with no task stay unanchored instead of being attached to a card they never named.
