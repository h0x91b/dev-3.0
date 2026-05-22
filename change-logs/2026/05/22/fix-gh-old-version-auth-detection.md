Fix GitHub CLI auth detection on older `gh` versions (e.g. v2.45.0) where `gh auth status --json hosts` exits with `unknown flag: --json`. The app now falls back to parsing the plain `gh auth status` text output, so authenticated users no longer see a false "GitHub CLI is not signed in" banner.

Suggested by @eyalizhaki (h0x91b/dev-3.0#569)
