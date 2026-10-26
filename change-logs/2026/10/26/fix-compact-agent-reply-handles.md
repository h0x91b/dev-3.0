Short: Shorter agent handles in reply commands

Agent handles printed by `dev3 pane list` and carried by reply commands shrink from a ~100-character base64 blob to `<pane>.<8-hex generation>` (e.g. `%14.6c0e3f1a`), and a reply command only carries `--agent` when the sending task runs more than one agent; a handle that no longer names the agent in its pane is still refused with nothing sent.
