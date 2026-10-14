Short: Each Claude pane resumes its own conversation

After a restart, a task with several Claude panes now brings every pane back on its own conversation instead of reopening one conversation in most of them. Each pane's saved conversation follows `/clear` and `/resume`, even into a conversation from another directory, and a pane with nothing of its own left, the main pane included, starts on a new empty conversation instead of duplicating another pane's.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1950)
