Short: Send messages up to 80 000 chars

`dev3 message` now accepts up to 80 000 characters instead of 10 000, and a body too large to type into a terminal is written to a file automatically — the agent receives that path inside the usual envelope instead of a `command too long` failure. The old limits were also wrong about what tmux can carry, so messages that passed validation could still die at delivery.
