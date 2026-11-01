Short: Usage stats no longer freeze dev3

Opening the Stats page or running `dev3 stats usage` no longer freezes the app while it reads agent transcripts. Unchanged transcripts are skipped on repeat scans, `--since` skips files last written before the window, a symlinked account store is read once, and parsing yields so other CLI calls keep answering.
