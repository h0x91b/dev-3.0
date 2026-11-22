Short: Cursor gets peer messages mid-turn

A `dev3 message` or prompt sent to a busy Cursor Agent no longer waits in Cursor's follow-up queue until the turn ends (often tens of minutes, with the user's own queued question stuck behind it). dev3 now presses one more Enter after it lands, which steers it into the running turn.
