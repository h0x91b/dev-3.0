# Remote access

dev-3.0 can run headless and serve its full UI to any browser — a laptop on the same LAN, a
phone anywhere in the world, or your desktop over an SSH tunnel. Same board, same terminals,
same live previews.

```sh
dev3 remote
```

That's the whole thing. It prints an ASCII QR code, a public URL, and an SSH-forward hint.

<p align="center">
  <img src="screenshots/remote-access.jpg" width="800" alt="Remote access modal with QR code and connection URLs">
</p>

## How the connection works

The access URL is signed with a short-lived JWT — **30 seconds, single use** — and the QR
auto-refreshes every 25 seconds. Once you scan it, the browser keeps a trusted session for 8
hours and reconnects on reload without rescanning.

Three ways in, printed on every start:

| | Route | When to use it |
|---|---|---|
| ① | **Cloudflare quick tunnel** (default) | From anywhere, no SSH setup. `cloudflared` ships as a brew dependency |
| ② | **LAN** | Scan the QR from any device on the same network |
| ③ | **SSH port-forward** | Most private — nothing is publicly exposed: `ssh -L <port>:localhost:<port> user@<server>` |

Pass `--no-tunnel` to skip the public tunnel entirely (LAN + SSH only).

## Background lifecycle (for SSH boxes)

`dev3 remote` backgrounds the server by default, so it survives your SSH session. From any
later session:

```sh
dev3 remote status          # running? PID, port, uptime
dev3 remote url             # fresh QR + URL to re-scan from your phone
dev3 remote logs --follow   # tail ~/.dev3.0/remote/remote.log live
dev3 remote restart         # relaunch (accepts start flags, e.g. --port 3000)
dev3 remote stop            # SIGTERM, then SIGKILL fallback
```

Add `--no-detach` to keep it in the foreground instead — required when a supervisor owns the
process (systemd `Type=simple`, a Docker `CMD`, …).

## Run it as a service (Linux)

```sh
dev3 remote install-service --port 3017   # systemd --user unit, enabled on boot
dev3 remote uninstall-service
```

Tip: `sudo loginctl enable-linger $USER` keeps user services running while you are logged out.
Under systemd the log goes to the journal: `journalctl --user -u dev3-remote.service -f`.

## Useful start flags

| Flag | What it does |
|---|---|
| `--port <n>` | Bind a fixed TCP port instead of a random one (ideal for `docker -p 3000:3000` or a preconfigured `ssh -L`) |
| `--no-tunnel` | No Cloudflare tunnel — LAN + SSH forward only |
| `--expose-ports=3000,5173` | Also publish your dev-server ports through their own quick tunnels (one URL per port). Retries for 60 s until each port is actually listening |
| `--no-detach` | Stay in the foreground; Ctrl-C stops it |
| `--views-dir <path>` | Serve static assets from a different directory |

`--static-code=<value>` replaces the rotating token with a fixed one. **Local development
only** — never expose a static code on the public internet.

## Security notes

- The rotating token is the only credential; treat a live tunnel URL as a live session.
- Diagnostic logs are kept for 14 days locally and redact prompt-bearing payloads and command
  arguments — see [Local diagnostic logs](diagnostic-logs.md).
- SSH port-forwarding exposes nothing publicly and reuses your existing SSH credentials. It is
  the right default for anything sensitive.

`dev3 remote --help` prints the complete flag reference.
