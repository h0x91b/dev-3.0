Short: Killed the merge-blocking flaky tests

Fixed the flaky tests that kept blocking merges on unchanged code. Toasts raised before the toast host subscribes are now queued and delivered instead of silently dropped, which also fixes losing a `dev3 show-image`/CLI toast that arrives during startup; the git test helpers no longer hang a whole suite when a spawn fails or when a temp repo is removed under a still-running git process; and the sharded CI test gate now tells you to re-run the whole workflow instead of just the aggregate job, which only re-reads the same artifacts.
