Short: Faster terminals, stable history copying

Reopening a terminal no longer briefly changes its height, preventing inline Codex sessions from unnecessarily printing their history again while preserving mouse scrolling. Copying selected history keeps its scroll position, while live-screen copying finishes immediately; normal typing or pasting resumes live input, while history navigation/cancel keys (including the touch key bar and vi copy-mode keys) stay in tmux. Real viewport resizing and the explicit Hard Reset action retain their existing behavior.

Contributed by @diverru (h0x91b/dev-3.0#2027)
