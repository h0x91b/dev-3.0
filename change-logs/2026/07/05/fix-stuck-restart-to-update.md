Fixed the "Restart to Update" button silently doing nothing. Electrobun's checkForUpdate() overwrites its in-memory state with the remote update.json (which has no updateReady field), so any periodic or manual check after a download wiped the ready flag and made apply refuse to run. The apply path now self-heals by re-running the (cheap, idempotent) download before restarting, download/apply are serialized so a background check can't wipe state mid-click, and an apply failure now surfaces as an error toast instead of being swallowed.

Suggested by @genrym (h0x91b/dev-3.0#813)
