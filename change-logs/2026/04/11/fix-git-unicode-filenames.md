Fixed Git-backed filename handling so Unicode and Cyrillic paths stay readable in branch diff stats and untracked file scans instead of showing escaped octal sequences. Added regression tests with a real Git repo to cover both branch diffs and untracked files.

Added and committed a repository file with a Russian filename to validate the end-to-end flow with a real tracked path.
