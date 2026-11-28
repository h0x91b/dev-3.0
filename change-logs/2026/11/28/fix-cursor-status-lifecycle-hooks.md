Short: Cursor tasks follow the board again

Cursor Agent tasks now get status hooks in `~/.cursor/hooks.json`, so replying to a task in Has Questions moves it back to Agent is Working, tool use keeps it there, the end of a turn parks it the same way as other agents, and a question the agent parked in Has Questions stays there until you reply. The hooks act only inside dev3 panes, keep your own Cursor hooks, and are removed with `dev3 install-hooks --remove-cursor`.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2446)
