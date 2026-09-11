# App-owned agent and favorites state must follow the pushes

## Context

The launch dialog reached from **New Task → Scratch Task / Save & Start** is rendered by
`App.tsx` (`LaunchVariantsModal`), which fed it `agents` from local state loaded exactly once —
the first time `createTaskProjectId` became set, guarded by `agentSettingsLoaded`. Connecting a
model provider from inside that dialog seeds two `Best value` presets (`seedPresetForTier`), and
they stayed invisible until the app restarted: the locked offers disappeared (correct — a provider
now exists) and nothing replaced them, so the user was left with fewer options than before.
Diagnosed in Seq 1884; every sibling surface (board `Run`, Spawn Agent, Bug Hunters, agent launch
request) was already live through `useAgents()`.

## Investigation

`AgentConfigPicker` carried a comment asserting that the agent list "refreshes itself off the
`agentsUpdated` push" — true everywhere except the one surface `App.tsx` owned, which is why the
bug survived review. Favorites failed for a second, independent reason: `toggleFavoriteAgent`
persisted the list and returned it to the caller, but never fanned out `globalSettingsUpdated`.
The Settings screen keeps its own `globalSettings` state, so a star set there never reached
`App.tsx`, and `resolveFavoriteChips` silently drops a favorite that does not resolve.

## Decision

`App.tsx` uses `useAgents()` (`src/mainview/hooks/useAgents.ts`) — no local agent state, no
one-shot guard; analytics registration now re-runs off the same value. `toggleFavoriteAgent`
(`src/bun/rpc-handlers/settings-config.ts`) pushes `globalSettingsUpdated` like
`saveGlobalSettings` does. The rule going forward: no surface keeps a fetch-once copy of agents or
settings, and every handler that mutates them fans out its push.

## Risks

`useAgents()` fetches on mount, so the agents RPC now runs at startup instead of on first New Task
— it replaced an existing mount-time `getAgents()` call for analytics, so the call count is
unchanged. The push echoes back to the renderer that triggered the toggle; it sets the same value,
so the extra render is idempotent.

## Alternatives considered

Lifting the Settings screen's `globalSettings` into `App.tsx` would fix favorites without touching
the handler, but it is a broad state refactor and would leave every other surface depending on
prop plumbing instead of the push. Re-fetching settings when the launch dialog mounts would still
go stale while the dialog is open.
