# syntax=docker/dockerfile:1.7

# ──────────────────────────────────────────────────────────────────────────────
# dev-3.0 — headless Docker image
#
# Runs `dev3 remote --port 3000` inside a minimal Debian container with tmux,
# git, and Bash. Any browser on the host (or across your LAN) can reach the
# UI over HTTP + WebSocket on the published port.
#
# Why a multi-stage build: `build:cli` and `build:server` rely on Bun's
# `--compile`, which emits a single-file ELF binary for the host it runs on.
# Building inside a Linux container guarantees Linux binaries regardless of
# whether the developer is on macOS, Windows, or Linux — and we keep the
# runtime image tiny by discarding the ~500 MB of node_modules / sources.
#
# Build:
#   docker build -t dev3-remote -f docker/Dockerfile .
#
# Run:
#   docker run --rm -it -p 3000:3000 \
#     -v "$HOME/.dev3.0-docker:/home/dev3/.dev3.0" \
#     -v "$HOME/projects:/workspace" \
#     dev3-remote
#
# Then scan the QR with your phone, or copy the printed URL and replace the
# container IP with `localhost` (Docker Desktop forwards :3000 → host).
# ──────────────────────────────────────────────────────────────────────────────

ARG BUN_VERSION=1.3.10

# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: builder — compile dev3 CLI + dev3-server + UI assets from source
# ──────────────────────────────────────────────────────────────────────────────
FROM oven/bun:${BUN_VERSION} AS builder

WORKDIR /src

# Dependency layer first (so code changes don't invalidate the npm install).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Source tree. .dockerignore excludes node_modules, dist, build, artifacts,
# change-logs from other sessions, .git worktree metadata, etc.
COPY . .

# UI bundle + native binaries. We skip `bun run build:cli`'s ad-hoc codesign
# step (it's a no-op on Linux anyway — see scripts/sign-cli-binaries.sh) and
# invoke the Bun compiles directly to keep the output deterministic.
RUN bun scripts/generate-build-info.ts \
 && bun scripts/generate-changelog.ts \
 && bunx vite build \
 && bun build src/cli/main.ts --compile --outfile dist/dev3 \
 && bun build src/bun/headless-bootstrap.ts --compile --outfile dist/dev3-server

# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: runtime — minimal Debian + the bits dev-3.0 actually spawns at runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM debian:stable-slim AS runtime

# Runtime deps — kept deliberately small:
#   tmux             — every task's terminal runs inside a tmux session
#   git              — worktree create / status / merge detection
#   bash             — resolveShellEnv() probes $PATH via `bash -lic`
#   ca-certificates  — TLS (HTTPS clones, Cloudflare tunnel, etc.)
#   openssh-client   — users often ssh out of the container for git auth
#   procps           — `ps` / `/proc` helpers used by resource-monitor
#   curl             — handy for sanity checks and for installing cloudflared later
# ──────────────────────────────────────────────────────────────────────────────
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux \
      git \
      bash \
      ca-certificates \
      openssh-client \
      procps \
      curl \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root user. dev-3.0 writes into $HOME/.dev3.0 (tasks, logs, sockets) and
# the spawned agents write into their worktrees, so root is both unnecessary
# and unsafe — especially if /workspace is bind-mounted from the host.
RUN useradd --create-home --shell /bin/bash dev3 \
 && mkdir -p /home/dev3/.dev3.0 /workspace \
 && chown -R dev3:dev3 /home/dev3 /workspace

USER dev3
WORKDIR /home/dev3/app

# Layout expected by the CLI: `dev3` and `dev3-server` side-by-side, with
# `dist/` adjacent for the UI (see headless-entry.ts candidate search).
COPY --from=builder --chown=dev3:dev3 /src/dist/dev3         ./dev3
COPY --from=builder --chown=dev3:dev3 /src/dist/dev3-server  ./dev3-server
COPY --from=builder --chown=dev3:dev3 /src/dist              ./dist

ENV PATH=/home/dev3/app:$PATH \
    DEV3_REMOTE_PORT=3000 \
    LANG=C.UTF-8

EXPOSE 3000

# tini reaps tmux/child zombies correctly on SIGTERM (the stock bun process
# isn't a PID-1 reaper). `--` separates tini's own flags from the payload.
ENTRYPOINT ["/usr/bin/tini", "--", "./dev3"]
CMD ["remote", "--port", "3000"]
