Short: Busy Claude agents read mail sooner

A `dev3 message` to a Claude agent that is in the middle of a turn now reaches it at its next tool call through the PostToolUse hook dev3 already runs, instead of being typed into the pane after the 15-second quiet window, and a long body arrives inline instead of as a file the agent has to read; the pane shows one line naming the sender and subject. Idle agents, other harnesses, the native terminal backend and external senders keep the typed delivery, and the Agent traffic view marks a hook delivery as delivered.
