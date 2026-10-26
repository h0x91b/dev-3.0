Short: Shorter agent handles in reply commands

Agent handles printed by `dev3 pane list` and carried by reply commands shrink from a ~160-character base64 blob to about 30 characters (e.g. `%14.9e2e9056.b9b6892e.7b707087`), and a reply command only carries `--agent` when the sending task runs more than one agent; a handle whose agent was replaced is still refused with nothing sent, while a conversation resumed in another pane is still followed.
