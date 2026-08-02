Short: AI Review starts on native tasks

Moving a task to AI Review did nothing on a task using the native terminal backend: the review agent was launched with a raw tmux split, which cannot work without a tmux session, and the failure silently bounced the card back to Your Review. The review agent now launches through the backend-neutral pane seam (no tmux on native, unchanged behaviour on tmux), repeated activation can no longer stack a second agent, and a launch that does fail now says so in a toast naming the column it was moved to.
