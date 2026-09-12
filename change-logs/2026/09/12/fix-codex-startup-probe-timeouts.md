Short: Bound Codex startup checks

Codex version and capability checks now run asynchronously with a two-second timeout, preventing a stuck check from freezing the app during startup or terminal restoration. Concurrent callers share checks, and an unavailable version leaves existing Codex configuration unchanged.
