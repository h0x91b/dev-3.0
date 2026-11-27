Short: Extra agents can close themselves

New `dev3 agent exit` lets an extra agent end its own session, and lets the main agent close one by handle with `--agent <handle>`. The exit is deferred to the end of the agent's turn, the pane then closes, and a task note keeps the conversation id and the resume command. Settings → Tasks & Board can turn the confirmation dialog off.
