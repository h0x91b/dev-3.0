Short: Board never hides a column holding tasks

The board no longer hides a review column that still holds cards: turning peer review off, or converting a board to Operations, used to take those tasks off the board entirely while they stayed in tasks.json and visible to the CLI, and a restart did not bring them back. A task whose status matches no column now lands in To Do instead of vanishing, and the tasks.json read cache keys on the file's inode so a same-size rewrite can never be served stale.
