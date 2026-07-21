Short: Preview next-release update popover

Add a dev-only "Preview update popover" tool in Settings → Developer Tools that simulates the update-ready popover's "what's new" section for the next release. It reuses the exact release-time window logic against the local change-logs and git tags — counting uncommitted and untracked entries too — so a developer can see what will make it in before shipping. Shows the real popover 1:1 plus the raw payload and window diagnostics (previous tag, entries in window, totals). Gated to the dev build channel.
