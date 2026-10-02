Short: Bind remote access to localhost

`dev3 remote --host 127.0.0.1` (or `localhost`; env `DEV3_REMOTE_HOST`) keeps the headless server on loopback; the default stays `0.0.0.0`. With `--host 127.0.0.1` the server is unreachable from the LAN, the access URL points at `localhost` and both the headless banner and `dev3 remote url` print it without a QR (a tunnel URL keeps one), `install-service` carries the flag into the systemd unit, and an invalid `DEV3_REMOTE_HOST` is refused rather than silently widened to every interface.
