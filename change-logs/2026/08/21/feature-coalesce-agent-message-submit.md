Short: Stacked messages arrive as one turn

`dev3 message` now types its text in at once but holds the Enter until the target
pane has been quiet for 10 seconds, so a burst of messages — one agent writing
three in a row, or several peers reporting at once — reaches the receiving agent as
a single turn instead of interrupting it once per message. A hard 30-second ceiling
keeps a steady stream from holding the submit forever, and button hand-offs
(Create PR, commit, rebase, bug-hunter prompts) still submit immediately. Typing
into the task's terminal pushes the Enter back too, so it never lands mid-word while
you are writing to the agent yourself.
