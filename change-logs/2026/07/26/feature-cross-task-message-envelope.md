Short: Cross-task agent messages are labeled

`dev3 message --task seq:N` sent from inside another task's worktree now arrives wrapped in a `<dev3-ai-message>` envelope carrying the sender's seq, title and the exact reply command, so the receiving agent immediately knows the text came from another agent and where to answer. Scheduled messages keep their plain text in the queue and get wrapped at delivery.
