Short: Custom agent presets survive upgrades

Custom agent presets no longer get wiped on upgrade: `agents.json` is now written atomically under a lock, and an unreadable file is never overwritten with defaults — its bytes are copied to `agents.json.corrupt-<timestamp>`, the presets are restored from the last-known-good copy when one exists, and a warning names the backup.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2434)
