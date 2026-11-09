# PTY server: loopback bind plus a per-launch access token

## Context
`Bun.serve` in `src/bun/pty-server.ts` had no `hostname`, so the terminal WebSocket listened on every interface (dual-stack), and the upgrade's only gate was `?session=<task id>`. A task id is not a secret: `dev3 pr create` writes it into every pull request footer. Anyone on the same network who found the port could attach to a live agent terminal and type (h0x91b/dev-3.0#2200).

## Investigation
Every consumer runs on this machine: the desktop renderer (URLs returned by RPC), the remote-access `/pty` proxy (`proxyToPty` dials upstream itself, so LAN, tunnel and SSH browsers only ever reach the cookie- and Origin-checked `/pty`), the tmux `pane-exited` hook (curl) and the loopback media routes. Checked live on macOS: with the bind on `127.0.0.1` a browser on the LAN address still drives a terminal through the proxy, the desktop WKWebView opens `ws://127.0.0.1` with the token, and the port no longer answers on the LAN address or on `::1`.

## Decision
- `PTY_SERVER_HOST = "127.0.0.1"` (`src/bun/pty-server-access.ts`) is both the bind and the host of every URL we mint. A literal, so no client depends on how its resolver orders `::1` for `localhost`.
- The upgrade requires a per-launch token (`hasPtyAccessToken`): 32 random bytes, kept in memory only, compared in constant time, carried as `?token=` by `ptyWsUrl()`. Every handler and the proxy build their URL through `ptyWsUrl`; logs get `redactPtyUrl` (`src/shared/pty-url.ts`) or no URL at all.
- A peer-address check stays in front of every route, in case the bind ever changes.
- `/pane-exited` stays token-free: a token on a curl command line is readable in `ps`, and the handler only reconciles against real tmux state.

## Risks
- The token travels in a URL. An authenticated remote browser receives it inside RPC results it discards; that client already drives every terminal through `/pty`, and the token is useless off this machine.
- Another OS user on the same machine can still call `/pane-exited` (harmless, see above) and probe the token-bearing media routes. The terminal itself is out of reach.
- A host with no IPv4 loopback would lose its terminals. The remote server and the tunnel make the same assumption.

## Alternatives considered
- Loopback peer check only, as the issue proposed and the sibling routes did: a tunnel or any local reverse proxy dials from loopback, so whatever it forwards passes, and so does another local user.
- An Origin allow-list on the upgrade: the desktop origin differs per platform (WKWebView, WebView2, WebKitGTK), and a non-browser client sends none.
- A setting to listen on the network: nothing legitimate needs it, since remote access has its own server with real authentication. It would only be a switch that re-opens the hole.
- The token in `Sec-WebSocket-Protocol` instead of the URL: every viewer would have to pass it and the server echo a subprotocol; masking it at the log sites is simpler.
