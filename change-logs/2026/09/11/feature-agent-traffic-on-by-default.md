Short: Agent traffic is on by default

Agent traffic and its log are now on out of the box instead of hidden behind an off-by-default beta toggle. The Settings → System → Advanced Experience switch still turns it off, and that choice is now stored as an explicit `false` so it survives restarts; installs that had switched the beta off before this change left no stored value and get the feature back on.
