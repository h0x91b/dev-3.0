# 032 — `window.__dev3` automation bridge for CDP testing

## Context

AI agents verifying UI changes via CDP (agent-electrobun) spent 80% of their effort navigating to the right view. Click-based navigation is fragile: task card clicks behave differently based on task status, refs invalidate on every DOM change, and there's no deterministic way to reach a specific screen.

## Decision

Added `window.__dev3` global in `src/mainview/App.tsx` with two methods:
- `navigate(route)` — programmatic navigation using the same Route type as the reducer
- `getState()` — returns current AppState (route, projects, tasks)

The bridge is guarded by `globalThis.__DEV3_AUTOMATION`, a Vite `define` flag set in `vite.config.ts`. It defaults to `true` and is only `false` when `DEV3_PROD=1` is set (which `bun run build:prod` does). This means the bridge is available in all dev/staging builds (including bundled assets), but tree-shaken out of production. Set up in a `useEffect` that depends on `[navigate, state]` and cleans up on unmount.

`dispatch()` was intentionally excluded — it's a foot-gun that would let CDP evals wipe UI state with no guardrails.

## Risks

- `getState()` returns a snapshot that may be stale by the time the eval result is processed. Fine for navigation and ID discovery, not for real-time assertions.
- The `state` dependency on the useEffect means the bridge object is recreated on every state change. This is cheap (object creation) and ensures `getState()` always returns current state.
- `getState()` exposes the internal `AppState` shape. If fields are renamed in a refactor, automation scripts break. Stable fields: `route`, `projects`, `currentProjectTasks`.

## Alternatives considered

- **Custom events only** (like existing `rpc:navigateToSettings`): Would require a new event per route type. The bridge is more flexible.
- **URL-based routing**: The app uses React state routing, not URL hash routing. Adding URL routing would be a larger change with broader impact.
- **Including `dispatch()`**: Rejected — too much power with no safety. An agent could dispatch `{ type: "setTasks", tasks: [] }` and wipe the board. `navigate` + `getState` covers all known automation needs.
