# 059 — Prevent-sleep header toggle, app-running semantics, remote force-on

## Context

Sleep prevention already existed as a buried Global Settings toggle
(`preventSleepWhileRunning`) whose backend (`caffeinate.ts`) only inhibited
sleep when at least one agent tmux session was active. We needed a prominent,
always-visible control and a "the machine must never sleep while it's reachable
remotely" guarantee.

## Decision

- Added `PreventSleepToggle` to the global header (left of Home Terminal), using
  a coffee glyph and a new semantic `--awake` token (amber, defined for dark and
  light themes; mapped in `tailwind.config.js`). Default on.
- Changed semantics in `caffeinate.ts`: `updateCaffeinateState(remoteActive: boolean)`
  now inhibits sleep whenever the setting is enabled (for the whole time the app
  runs — the resource-monitor poll keeps the inhibit process alive) OR whenever
  remote access is active, regardless of the setting.
- Remote-active = Cloudflare tunnel `connected` OR a connected browser RPC client,
  exposed as `remote-access-server.isRemoteAccessActive()`.
- New RPCs in `app-handlers.ts`: `getPreventSleepState` ({enabled, available,
  forcedByRemote}) and `setPreventSleep` (persists + re-evaluates immediately).

## Risks

- App-running semantics mean a laptop won't sleep while dev-3.0 is open (heavier
  on battery than the old agents-active gate). This is intentional per the user's
  request; the toggle and the Settings entry both allow turning it off.
- Remote-forced state in the header refreshes on mount and window focus, so a
  tunnel started while the header is already focused may take a focus cycle to
  reflect the locked state (the backend forces inhibition immediately regardless).

## Alternatives considered

- Keep the agents-active gate (battery-friendly) — rejected: doesn't match the
  requested "awake while the app is open" behavior.
- Reuse `--warning` (amber) for the active color — rejected: semantically "caution".
  Reuse `--accent` — rejected: not visually distinct enough from other header
  toggles. Introduced a dedicated `--awake` token instead.
- Import `remote-access-server` statically into `resource-monitor.ts` — rejected:
  it pulls electrobun-heavy modules and broke `resource-monitor.test.ts` at load.
  The poll imports it lazily (`await import`) so the poller stays unit-testable.
