Short: Diff stats stay visible on task switch

Switching tasks no longer blanks the diff summary and ahead/behind counts into a spinner: the last known numbers for that task and compare ref are kept and replaced in place once the refresh lands. The spinner now only shows for a task whose status has never been fetched. The status poll also no longer restarts on every render, so a task-list update stops triggering an extra git status fetch.
