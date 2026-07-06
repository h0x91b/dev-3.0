# 111 — Fresh window/route on local dev launches

## Context
On every `bun run dev`, the app restored the last window geometry, re-entered macOS
fullscreen, and reopened the last task. During active development this makes the
screen flicker/relocate on each relaunch — genuinely disruptive.

## Decision
Added a `DEV3_FRESH_START=1` env var, set by the `dev` and `start` npm scripts, read via
`isFreshStartMode()` (`src/bun/fresh-start.ts`). When on:
- `createAppWindow` (`src/bun/window-manager.ts`) skips `loadWindowState()` and always
  opens the default centered, windowed frame (no fullscreen restore).
- `getLastRoute` (`src/bun/rpc-handlers/settings-config.ts`) returns `{ route: null }`,
  so the renderer always lands on the dashboard.

It also stops *persisting* that state in dev: `captureWindowState` short-circuits (and the
move/resize listeners aren't attached), and `saveLastRoute` becomes a no-op.

## Risks
Low. `window-state.json` / `last-route.json` live in the cross-install `~/.dev3.0` home, so
a dev run that kept saving would clobber the real (prod) install's restore — hence dev must
not write them, only skip reading. Prod/staging builds never set the env var, so behavior
there is unchanged. Env propagates to the bun process the same way `DEV3_REMOTE_*` already do.

## Alternatives considered
- Gate on `channel === "dev"` instead of an env var: simpler but also fires for any dev-channel
  build and gives no explicit opt-out; the env var keeps the trigger scoped to the dev scripts.
- Only skip *restore* but keep saving: rejected — dev would still clobber the shared prod state.
