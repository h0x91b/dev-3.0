Short: Update channel hidden until it works

The update-channel picker went out live in 1.42.1, but nothing is published on the second channel yet — choosing it left the app showing a bare HTTP 403 instead of an update. The picker is disabled again and a channel already saved is read back as stable, so anyone who switched is returned to working updates without touching their settings file. The hourly publishing job is off for the same reason, rather than failing every hour.
