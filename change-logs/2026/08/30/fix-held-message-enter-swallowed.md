Short: dev3 message no longer gets stuck unsent

A `dev3 message` sometimes pasted its whole text into the receiving Claude Code pane without submitting it, and every later message then piled onto the same unsubmitted input box. The Enter that ends a held burst now keeps the same 800 ms gap behind it that button hand-offs already had, so the agent's input layer cannot read it as part of the paste.
