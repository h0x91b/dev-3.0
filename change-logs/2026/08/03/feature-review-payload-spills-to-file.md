Short: Big reviews reach the agent as a file

Sending a large review to the agent no longer fails on the message-length guard: payloads over 8 000 characters are written to a file next to the task worktree and the agent is sent that path with a one-line instruction to read it. The toast names the file. Applies to the batch review send, the per-comment send and the GitHub PR-thread send alike.
