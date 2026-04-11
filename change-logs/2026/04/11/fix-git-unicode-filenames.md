Fixed Git-backed filename handling so Unicode and Cyrillic paths stay readable in branch diff stats and untracked file scans instead of showing escaped octal sequences. Added regression tests with a real Git repo to cover both branch diffs and untracked files.

Temporarily added a Russian-named repository file to validate the tracked-path flow end to end, then removed it after verification.
