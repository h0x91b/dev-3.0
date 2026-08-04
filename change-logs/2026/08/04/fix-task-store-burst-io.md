Short: Fewer whole-file reads per task save

The hourly task-store backup now checks with a stat() whether this hour is already
snapshotted, instead of reading both the board and the existing backup in full before every
save. On a 1509-task project a burst of ten saves moves 74 MB instead of 221 MB, with the
same once-per-hour snapshot; a save that crosses an hour boundary is now filed under the hour
it started in, and expired backups are pruned when the next snapshot is written.
