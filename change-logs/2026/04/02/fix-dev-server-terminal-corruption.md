Fix terminal rendering corruption when a dev server pane closes inside a nested tmux session. The wrappedScript now calls `tmux detach-client` before its pane exits, so inner tmux redraws without a watching client and the escape sequences never reach the outer tmux. The viewer pane's attach command is now a while-loop that re-attaches if the inner session is still alive (e.g. a frontend pane is still running after the backend closes).

Suggested by @dolev (h0x91b/dev-3.0#116)
