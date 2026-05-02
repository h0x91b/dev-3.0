# dev-3.0 in Docker (experimental)

Run `dev3 remote` inside a container so you can test the browser UI
without a real Linux server. Everything in this directory is **for
testing the `--remote` flag** — it's not a production deployment.

## Quick start

```bash
# From the repo root:
docker build -t dev3-remote -f docker/Dockerfile .

# Run it, forwarding :3000 to your host:
docker run --rm -it -p 3000:3000 dev3-remote
```

Open the URL printed in the container logs, **replace the IP with
`localhost`** (the container sees its own IP, not yours), and you're in.

Prefer `docker compose`? From the repo root:

```bash
docker compose -f docker/docker-compose.yml up --build
```

## Persist data between runs

Add volumes so tasks and workspaces survive `docker rm`:

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v "$HOME/.dev3.0-docker:/home/dev3/.dev3.0" \
  -v "$HOME/projects:/workspace" \
  dev3-remote
```

## Memorable access code

QR rotation + single-use JWTs are great for LAN, annoying for a
dev loop. Pin a fixed code (≥ 4 chars) with `--static-code`:

```bash
docker run --rm -it -p 3000:3000 \
  dev3-remote remote --port 3000 --static-code=letmein
```

Then open `http://localhost:3000/?token=letmein` — no rotation.

⚠ **Local-only.** There's no replay protection — never expose a
static code to the public internet.

## Public tunnel (optional)

`--tunnel` spins up a Cloudflare quick tunnel, but `cloudflared`
isn't bundled in the image by default (keeps it small). Drop it
into the image yourself, or install at runtime:

```bash
docker run --rm -it -p 3000:3000 dev3-remote bash -c '
  curl -sSL -o /tmp/cf https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 &&
  install -m 0755 /tmp/cf /home/dev3/app/cloudflared &&
  dev3 remote --port 3000 --tunnel
'
```

## What's inside

- `debian:stable-slim` base
- `tmux`, `git`, `bash`, `ca-certificates`, `openssh-client`, `procps`, `curl`, `tini`
- Non-root user `dev3` (UID 1000-ish) with `$HOME=/home/dev3`
- Binaries at `/home/dev3/app/{dev3,dev3-server}` and `dist/` for the UI
- `DEV3_REMOTE_PORT=3000` exported by default

No AI CLIs (claude, codex, etc.) are pre-installed — drop them in
with a custom layer if you want to test agents end-to-end.
