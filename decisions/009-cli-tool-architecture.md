# 009 — CLI Tool Architecture

## Context

AI agents running inside dev3.0 worktrees need a lightweight way to manage their own tasks (update status, check info) without MCP. A CLI tool is cheaper in tokens and works natively with bash.

## Investigation

Electrobun's Zig launcher initializes the native GUI event loop before any Bun code runs. There is no way to conditionally skip GUI initialization from the Bun layer, so the CLI cannot be built into the existing binary.

## Decision

The CLI is a **standalone Bun script** (`src/cli/main.ts`) that communicates with the running Electrobun app via a **Unix domain socket**. The socket server lives in `src/bun/cli-socket-server.ts` and starts automatically on app launch. Multi-instance support uses PID-based socket paths (`~/.dev3.0/sockets/<pid>.sock`). Worktrees get a `.dev3-marker` JSON file (written during `git.createWorktree()`) containing `projectId`, `taskId`, and `socketPath` for auto-detection. The CLI binary (`~/.dev3.0/bin/dev3`) is symlinked to `/usr/local/bin/dev3` on every app startup.

## Risks

- Symlink creation to `/usr/local/bin/` may fail without sudo — handled as best-effort with a warning log.
- If the app crashes, the socket file is orphaned — cleaned up on next startup via PID liveness check.
- `.dev3-marker` socket path becomes stale if the app restarts — CLI falls back to socket discovery via `~/.dev3.0/sockets/`.

## Alternatives considered

- **Built into Electrobun binary**: Not feasible due to Zig launcher GUI initialization.
- **HTTP server instead of Unix socket**: More overhead, port conflicts, security concerns.
- **Direct file access (no socket)**: Can't trigger side effects like PTY/worktree creation on status change.
- **MCP server**: Higher token cost, more complex setup. CLI is simpler for agents.
