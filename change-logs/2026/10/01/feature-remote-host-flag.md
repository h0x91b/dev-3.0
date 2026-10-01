Short: Bind remote access to localhost

`dev3 remote --host <addr>` (env `DEV3_REMOTE_HOST`) sets the address the headless server listens on; the default stays `0.0.0.0`. With `--host 127.0.0.1` the server is unreachable from the LAN, the access URL points at `localhost` and both the headless banner and `dev3 remote url` print it without a QR (a tunnel URL keeps one), and `install-service` carries the flag into the systemd unit.
