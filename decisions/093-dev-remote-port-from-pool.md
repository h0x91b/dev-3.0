# 093 — Pin the dev app's remote web UI to a pool-allocated port

## Context

`bun run dev` launches the dev build, which serves the full web UI in local
remote mode (the `DEV3_REMOTE_STATIC_CODE` path) — but on a **random** port
(`resolveListenPort()` returns 0 when `DEV3_REMOTE_PORT` is unset, so `Bun.serve`
picks one). An agent QAing its own worktree (the `/debug-ui` flow) therefore
couldn't derive the URL; the workaround was to start a separate
`dev3 remote --port <fixed>` just to get a predictable port.

## Decision

Wire the repo's `dev` script to pin the remote server to the task's first
pool-allocated port: `DEV3_REMOTE_PORT=${DEV3_PORT0:-0} electrobun dev`
(`package.json`). The dev-server already injects `DEV3_PORT0..N` into the
`devScript` env when the project's Port Allocation (`portCount`) is ≥ 1
(`src/bun/rpc-handlers/tmux-pty.ts` → `buildPortEnv`). The `:-0` fallback keeps a
bare `bun run dev` (no dev-server, `DEV3_PORT0` unset) working = random, exactly
as before. Result: the dev web UI binds the same port `dev3 dev-server status`
prints as `DEV3_PORT0=<port>`, so the QA URL is fully derivable from the CLI.

`resolveListenPort()` is left untouched — `DEV3_REMOTE_PORT` stays the single
explicit knob; the dev script just maps the pool port onto it.

**Prerequisite (per-machine, not in-repo):** the dev-3.0 project must have Port
Allocation ≥ 1 (Project Settings → Port Allocation) for `DEV3_PORT0` to exist.
With it at 0 the wiring is inert and the port stays random — graceful
degradation to the old behavior.

## Dev-only vs general for user projects

**Dev-only.** `DEV3_REMOTE_PORT` binds the dev3 app's *own* remote web server.
Only the project that *is* the dev3 app (self-hosting) runs that server from its
`devScript`. A user project's `devScript` launches the user's app, which dev3
already exposes via the shared-tunnel `/p/<subtoken>/<port>/` reverse proxy —
there is no dev3 remote server in a user project to pin. So there is nothing to
generalize; the env var is meaningless in a user-project `devScript`.

## Risks

- If `portCount` is 0 the feature is inert (random port). Documented as a
  prerequisite in `/debug-ui` and the AGENTS.md QA section.
- Bun's script shell must support `${VAR:-default}` parameter expansion — it does
  (POSIX); a `package-scripts.test.ts` guard asserts the wiring literally.

## Alternatives considered

- **`resolveListenPort()` falls back to `DEV3_PORT0`.** Avoids the package.json
  edit but conflates two env contracts (`DEV3_PORT0` = user-app port pool;
  `DEV3_REMOTE_PORT` = dev3 server port) and changes shipped-app runtime behavior
  globally. Rejected — keep one explicit knob.
- **Allocate a deterministic port in the dev script itself** (bypassing the
  pool). Rejected — would collide across concurrent worktrees; the pool exists to
  prevent exactly that.
