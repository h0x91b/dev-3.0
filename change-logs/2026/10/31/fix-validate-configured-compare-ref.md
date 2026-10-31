Short: Missing compare ref falls back to default

A project compare ref that the repository does not have (for example `origin/master` in a repo that only has `main`) is now replaced by the auto-detected default instead of making every branch-status poll, merge check and rebase fail; the mismatch is logged once.
