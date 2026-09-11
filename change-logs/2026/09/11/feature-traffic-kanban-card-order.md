Short: Traffic cards ordered like the board

Agent traffic's node stage now orders task cards by their own Kanban column instead of by seq alone: the column nearest the coordinator is the one the board puts first, so active work sits closest and Completed/Cancelled trail at the far end. To Do cards are left off the stage entirely — their wires go with them, while the message log and replay timeline keep every row — and during replay the column is read at the playback cursor so a task's current status no longer leaks into historical ordering.
