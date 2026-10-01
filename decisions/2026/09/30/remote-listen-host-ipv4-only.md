# Remote listen host: IPv4 literals only, loopback rewrites the advertised URL

## Context
The remote-access server always bound `0.0.0.0`. On a machine whose LAN is not trusted, or a WSL install switched to mirrored networking, that publishes the sign-in endpoint to every host on the network even when the user only ever opens it from the same machine. `--no-tunnel` removes the public route but not the LAN one.

## Decision
`DEV3_REMOTE_HOST` (set by `dev3 remote --host`) chooses the bind address. Accepted values are an IPv4 literal or `localhost` (mapped to `127.0.0.1`); anything else falls back to `0.0.0.0` with a warning in the server, and is refused with a usage error by the CLI and `install-service`. When the bind is loopback, `getLocalIp()` returns `localhost`, the interface picker offers loopback alone, and the headless banner replaces the LAN route with a this-machine-only line. When the bind is one specific non-loopback address, only that address is advertised.

## Risks
A user who binds a specific LAN address loses the loopback route (`127.0.0.1` is not that address); the picker no longer offers it, so this is visible rather than a dead link.

## Alternatives considered
- Accept IPv6 (`::1`, `::`): `cloudflare-tunnel.ts` dials `http://localhost:<port>` and access URLs are built as `http://<ip>:<port>`; both would need bracket handling and dual-stack testing for no requested use.
- A `remoteHost` setting for the desktop app: the GUI cannot receive `DEV3_*` env (see `resolveListenPort`), so it would need a setting, UI and i18n. Left for a follow-up if wanted.
