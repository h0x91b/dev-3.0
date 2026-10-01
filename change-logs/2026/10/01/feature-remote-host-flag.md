Short: Bind remote access to localhost

`dev3 remote --host <addr>` (env `DEV3_REMOTE_HOST`) sets the address the headless server listens on; the default stays `0.0.0.0`. With `--host 127.0.0.1` the server is unreachable from the LAN, the access URL points at `localhost` and the headless banner drops its QR (unless a tunnel is up), and `install-service` carries the flag into the systemd unit.
