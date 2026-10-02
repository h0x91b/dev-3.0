# Remote listen host: loopback or every interface, loopback rewrites the advertised URL

## Context
The remote-access server always bound `0.0.0.0`. On a machine whose LAN is not trusted, or a WSL install switched to mirrored networking, that publishes the sign-in endpoint to every host on the network even when the user only ever opens it from the same machine. `--no-tunnel` removes the public route but not the LAN one.

## Decision
`DEV3_REMOTE_HOST` (set by `dev3 remote --host`) chooses the bind address, and accepts exactly `127.0.0.1`, `localhost` (mapped to `127.0.0.1`) or `0.0.0.0` (`LISTEN_HOSTS` in `src/shared/remote-listen-host.ts`). Anything else is refused with a usage error by the CLI (the `--host` flag and an inherited `DEV3_REMOTE_HOST` alike) and `install-service`; a value that still reaches the server makes it fall back to `127.0.0.1` with a warning, because whoever set the variable wanted less exposure, never more. When the bind is loopback, `getLocalIp()` returns `localhost`, the interface picker offers `localhost` alone (the same spelling, so the selected value is one of its options), and the headless banner replaces the LAN route with a this-machine-only line.

## Risks
A user who wants one specific LAN interface still gets every interface with the default bind. A malformed `DEV3_REMOTE_HOST` handed straight to the headless entry (Docker, no CLI in between) leaves the server unreachable from outside the container instead of exposed; that failure is loud, the alternative was silent.

## Alternatives considered
- Any IPv4 literal (the first version of this branch): `cloudflare-tunnel.ts` dials `http://localhost:<port>`, so a bind to one LAN address breaks the default tunnel, and the banner's LAN list, the SSH-forward tip and the access-host allow-list all keep advertising addresses that no longer answer. Fixing each path costs more than the use case is worth.
- Accept IPv6 (`::1`, `::`): access URLs are built as `http://<ip>:<port>`; brackets and dual-stack testing for no requested use.
- A `remoteHost` setting for the desktop app: the GUI cannot receive `DEV3_*` env (see `resolveListenPort`), so it would need a setting, UI and i18n. Left for a follow-up if wanted.
