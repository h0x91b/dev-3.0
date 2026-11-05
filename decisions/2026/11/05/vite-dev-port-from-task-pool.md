# Vite dev port comes from the task pool, never a fixed 5173

## Context
On the `dev` channel `getMainViewUrl()` probed a hardcoded `http://localhost:5173` and loaded whatever answered. Another agent's Vite app (a base44 scratchpad) held 5173, so the dev window showed that app's 404 page. The earlier fix only bounded the probe with a 1 s timeout, which helps against a squatter that never answers, not one that does.

## Decision
The only Vite port is the task's own pool port `DEV3_PORT1` (`DEV3_PORT0` is already the remote web UI), read by `viteDevPort()` in `src/shared/vite-dev-server.ts`. `resolveMainViewUrl()` in `src/bun/main-view-url.ts` probes it only on the dev channel and only when it is set; otherwise it returns the bundled `views://` URL without touching the network. `vite.config.ts` uses the same helper for `server.port` (with `strictPort`) and refuses `vite serve` when the port is missing. `.dev3/config.json` `portCount` is 2.

## Risks
A dev build launched outside a dev3 task (Finder, a plain terminal) never uses a Vite server — intended, since HMR is banned for agents anyway. A task created before `portCount` became 2 has no `DEV3_PORT1` until its ports are reallocated, so it also just loads bundled assets.

## Alternatives considered
- Drop the probe entirely (HMR is banned): simplest, but removes a working opt-in for a human who wants HMR inside a task.
- Probe only behind an explicit opt-in env (`DEV3_VITE_HMR=1`): still needs a port, and a hardcoded one is the bug; a task port already is the opt-in.
- Keep 5173 but verify the response is dev3 (marker in the HTML): narrows the hijack but still collides with other projects and makes two dev3 worktrees fight over one port.
