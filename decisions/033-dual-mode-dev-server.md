# 033 — Dual-mode dev server (browser vs native CDP)

## Context

Agent UI verification used agent-electrobun via CDP, which required bundling CEF in dev builds. This added build time, binary size, and complexity (per-task CFBundleIdentifier hack). Meanwhile, the remote access server already serves the full UI to any browser — agent-browser (Playwright-based) could test the same React components without CEF.

## Decision

Two platform changes enable any project to use agent-browser for UI testing:

1. **Fixed port for remote access server:** When `DEV3_RPC_PORT` is set in the environment, the remote access server listens on that port instead of a random one. The devScript sets this from `DEV3_PORT0` (the port pool allocation).
2. **Localhost auth bypass:** When `DEV3_RPC_PORT` is set, localhost connections skip JWT authentication, allowing agent-browser to connect without a QR token.

Mode switching is handled entirely in the project's devScript (`.dev3/config.json`), not in the dev3 platform. The dev-3.0 project's devScript branches on `DEV3_CDP`:

- **Browser mode (default):** `DEV3_RPC_PORT=$DEV3_PORT0 bun run dev` — remote access server on a known port, no CEF.
- **Native/CDP mode:** Override via `.dev3/config.local.json` with `DEV3_CDP_PORT=$DEV3_PORT0 bun run dev` — bundles CEF for agent-electrobun.

Code paths: `remote-access-server.ts` (fixed port + auth bypass). No changes to the generic `runDevServer`, CLI, or socket handler.

## Risks

- If `DEV3_RPC_PORT` is already in use (stale process), the server fails to start. Random port (old default) never had this problem.
- Localhost auth bypass means any local process can connect to RPC in dev mode. Acceptable for local development.

## Alternatives considered

- **`--native` CLI flag:** Would pass a mode toggle through the generic dev3 CLI → socket → runDevServer pipeline. Rejected — bakes a project-specific concept (CEF/CDP) into the platform. Mode switching belongs in the devScript.
- **Vite proxy approach:** Add WebSocket proxy in vite.config.ts to forward /rpc to the backend. Rejected — adds a proxy hop and the Vite dev server isn't running per-task anyway (each task runs `vite build`, not `vite serve`).
- **Per-task Vite port allocation:** Allocate a second port for the Vite dev server per task. Rejected — unnecessary since the remote access server already serves built assets.
