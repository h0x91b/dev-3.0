# 036 — Docker image for `dev3 remote` + fixed listen port

## Context

`dev3 remote` is meant to be run on a remote Linux host that users reach
through a browser (reverse proxy, SSH tunnel, LAN, etc). We want a way to
test this end-to-end without a real Linux box — Docker is the obvious
alternative.

The blocker is that `remote-access-server.ts` always calls
`Bun.serve({ port: 0 })`, so the server picks a random free port at
startup. Docker requires the container-side port to be known at
`docker run -p <host>:<container>` time, and host-networking on macOS
Docker Desktop is unreliable. Scraping the banner line for the port is
fragile and makes compose files awkward.

## Investigation

- `DEV3_REMOTE_*` env vars already exist for tunnel and static-code
  flags, so adding `DEV3_REMOTE_PORT` matches the established pattern.
- `getServerPort()` is used by `remote-console.ts` and `getAccessUrl()`
  to build SSH-forwarding hints and the QR URL — since `Bun.serve`
  fills in `server.port` regardless of whether we passed 0 or a number,
  all downstream consumers keep working unchanged.
- `bun build --compile` on Linux emits a Linux ELF binary, so a
  multi-stage Dockerfile with `oven/bun` as the builder produces the
  right `dev3` / `dev3-server` binaries from the host's Mac/Linux
  checkout.

## Decision

1. Added `resolveListenPort()` in `src/bun/remote-access-server.ts`
   (exported for tests). Parses `DEV3_REMOTE_PORT`, validates the
   1–65535 range, falls back to 0 on anything invalid with a warn log.
   `startRemoteAccessServer` passes the result to `Bun.serve({ port })`.
2. Added `--port <n>` to `dev3 remote` CLI (`src/cli/commands/remote.ts`).
   Validates the value (integer, 1–65535, no trailing garbage) before
   exporting `DEV3_REMOTE_PORT` to the spawned server.
3. Shipped `docker/Dockerfile` (multi-stage), `docker/docker-compose.yml`,
   and `docker/README.md`. Runtime image is `debian:stable-slim` with
   `tmux`, `git`, `bash`, `ca-certificates`, `openssh-client`, `procps`,
   `curl`, `tini`. Non-root user, binaries at `/home/dev3/app`,
   `DEV3_REMOTE_PORT=3000` baked in, `EXPOSE 3000`, `tini` as PID-1
   reaper for the tmux subprocess tree.

## Risks

- The container prints the LAN IP it sees (e.g. `172.17.0.2`) in the
  QR URL, so the user has to mentally translate the host to `localhost`
  when using Docker Desktop's port forwarding. We accepted this over
  introducing yet another env (`DEV3_REMOTE_PUBLIC_HOST`) in the same
  PR — it's a fine follow-up.
- No AI CLIs (`claude`, `codex`, …) are pre-installed. That's
  intentional — keeps the image small, and users who want to test
  agents end-to-end can add a derived `Dockerfile` layer.
- `bun build` runs without `--target` in the builder; if someone builds
  the image on a non-x64/arm64 host via BuildKit's QEMU emulation, they
  get a binary for the emulated arch. That's the desired behaviour.

## Alternatives considered

- **Host networking (`--net=host`).** Works on native Linux; on Docker
  Desktop for macOS it's still a beta and leaks all container ports
  to the host. Rejected — fragile and platform-dependent.
- **Use the prebuilt `stable-linux-x64-dev-3.0.tar.zst` from the S3
  release.** Avoids a builder stage, but pins the image to whatever
  tag is released and makes testing HEAD impossible. Rejected.
- **Require `--tunnel` in the container.** Clean (no port mapping
  needed), but ties every test run to `cloudflared` and Cloudflare's
  `trycloudflare.com` rate limits. Rejected as the default; `--tunnel`
  is still documented as an opt-in.
