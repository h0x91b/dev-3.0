Short: Native journal proof says what broke

The native-session registry's Windows lifecycle proof reported journal isolation as one
boolean over two unrelated properties, so a red run could name neither: a session's own
output is now awaited to a ceiling instead of a fixed 400 ms sleep, cross-session leakage is
re-checked on every observation so waiting can never hide it, and a failure names the cause,
the fix and the journal contents it saw. Whether this also removes the intermittent Windows
red is unproven — only recurrence will tell, and the log will then say which half broke.
