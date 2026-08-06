Short: Update-channel plumbing behind a gate

The stable/unstable update channel is now implemented end to end — one persisted setting, three separate ordering rules, and a confirmation that says what switching back costs — but the Settings control stays disabled until the unstable feed exists, so nothing changes for anyone yet. The old "canary" channel value is gone; anything unrecognised in settings.json reads as stable.
