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

The access URL is signed with a short-lived JWT — **65 seconds, single use** — and the QR
auto-refreshes every 60 seconds. Once you scan it, the browser keeps a trusted session for 8
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

## Keeping the box up to date

A remote box is the one place where "there is an update, press restart" never gets pressed —
nobody opens a terminal on it. So it updates itself.

**By hand, from anywhere:**

```sh
dev3 update --check     # is there anything newer?
dev3 update --dry-run   # which install method was detected, and what would it run
dev3 update             # do it
```

`dev3 update` works out how this dev3 was installed — Homebrew formula, Homebrew cask, or a
plain CLI tarball — and does the right thing for it. On the **canary** channel it always uses
the tarball, because the brew tap only ever carries stable. It refuses, with the reason
printed, when it cannot safely touch the install: running from source, Windows (no CLI
tarball yet), a macOS `.app` Homebrew does not manage, or a cask whose recorded version has
drifted behind the running app. Refusals exit `15`.

**By itself, once the box is quiet.** The server checks every 30 minutes and installs the
update on its own when all three of these have held together for 10 minutes:

- no task in the **In Progress** column,
- no terminal producing output,
- no browser connected.

Past **72 hours** of waiting, only the first condition still applies — otherwise one browser
tab left open on a phone could pin the box on an old build forever. Turn the whole thing off
in **Settings → System → "Update a remote box on its own"** to hold a box on one build while
you investigate something.

**The restart keeps your link.** The dying server hands its port and its *live* `cloudflared`
process to the replacement, so the `*.trycloudflare.com` URL does not change, the host-bound
session cookie still matches, and the browser reconnects on its own. Running agents survive
too — their tmux sessions are detached and task lifecycles are rehydrated at boot.

Two caveats worth knowing:

- **Under systemd** the unit's cgroup is torn down when the unit stops, which takes
  `cloudflared` with it. The update still happens (systemd relaunches the unit), but the
  public URL **changes** — re-run `dev3 remote url`.
- **There is no "updating…" screen.** A silent overnight restart looks exactly like the box
  falling over. `dev3 remote status` prints a `Last update:` line that explains it.

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
