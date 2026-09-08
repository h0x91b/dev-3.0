Short: Notification history as thought clouds

Recorded `dev3 notify` calls can now be read back and shown as thought clouds hanging over the card that sent them — green for success, blue for info, red for error — carrying the level, the delivery mode and whether the notification actually reached you. A new read API serves the archive newest-first with its real date range, a filesystem watcher picks up rows another running instance wrote, and rows with no task stay unanchored instead of being attached to a card they never named.
