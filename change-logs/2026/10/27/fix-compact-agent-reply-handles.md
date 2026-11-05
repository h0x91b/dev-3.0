Short: Shorter agent handles in reply commands

Agent handles printed by `dev3 pane list` and carried by reply commands shrink from about 160 to about 62 characters with the same identity encoded losslessly, and a reply command only carries `--agent` when the sending task runs more than one agent.
