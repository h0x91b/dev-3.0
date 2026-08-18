Short: Terminal survives a bad frame

The terminal now keeps painting through a frame that crashes instead of going
blank for good, and a pane that stopped painting with no error at all is detected
and rebuilt. Two catch blocks that used to swallow ghostty crashes silently now
log them with the byte and frame counts around the failure, so a blank pane can be
diagnosed from the log instead of guessed at. Every one of those log lines now also
carries the last few things that happened to that terminal — successful resizes,
scale-factor changes, backgrounding — plus how many panes are alive and how many
have died, which is what identifies the trigger rather than just the symptom.
