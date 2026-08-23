Retuned the window that holds a `dev3 message` Enter so a burst of peer messages
becomes one agent turn: the quiet window is now 15 seconds (was 10) and the hard
ceiling 60 seconds (was 30). The CLI's "sent" line and the injected agent skill
text now quote the live constant instead of restating it, so the number agents are
told can no longer drift from the number the code honours.
