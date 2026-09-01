Short: Hourly backups of all your state

Every file of user state in ~/.dev3.0 now gets the hourly safety copies that projects.json already had — spaces, settings, agent presets, Operations boards and the model catalog, each with a last-known-good copy that rotation can never evict and that refuses to advance onto a collapsed file. Credentials are deliberately left out, and restoring is always a manual step: see docs/state-backups.md.
