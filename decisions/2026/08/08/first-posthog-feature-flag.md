# The project's first PostHog feature flag, and the pattern every later one follows

## Context

Two remote-terminal latency fixes needed a rollout switch (seq 1470, investigation
in seq 1468): a leading-edge flush in `enqueuePtyData` and backpressure on the
broadcast, both in `src/bun/pty-server.ts`. The repo had no feature-flag
infrastructure at all — `posthog-js` was initialized in the renderer for `capture`
only, `posthog-node` was not installed, and there were zero references to
`getFeatureFlag` / `onFeatureFlags` anywhere in `src/`.

Both fixes live in the bun process; PostHog lived only in the renderer behind
`VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`, which do not exist in bun.

## Investigation

**Local evaluation is banned for this app.** PostHog's local evaluation requires a
personal API key inside the SDK. dev3 is a desktop app installed on users'
machines, so shipping one would hand every user account-level access to our
PostHog project. Nobody may "optimize" into it later; the 600/min limit and the
10-flag-requests-per-definitions-fetch billing in PostHog's docs describe a server
deployment we do not have.

**There is no instant kill switch, and no engineering on our side creates one.**
PostHog has no push or subscription channel for flags: request #25820 (SSE/websocket
flag subscriptions) was closed, and #28517 "Real-time feature flags" sits unassigned
in their backlog with PostHog stating flags do not propagate immediately. Their own
position is that flags are for persistent changes, not instantaneous logic switches.
The polling interval therefore *is* the worst-case propagation delay.

**Cost of remote evaluation** at a 5-minute cadence: 12 requests/hour, ~288/day,
~8 600/month per install (derived). At 30 seconds that becomes ~86 000/month per
install — 10x the cost for a delay that is still not instant.

**Where backpressure is actually visible.** Every socket in `session.clients` is
loopback: the desktop renderer connects to the PTY server on localhost, and in
remote mode so does the proxy in `remote-access-server.ts`. The proxy's upstream
`WebSocket` client reads without flow control, so the loopback hop never shows a
backlog however slow the viewer is. The only socket in the chain that faces the
tunnel is the proxy's browser-facing `clientWs`, whose buffer grows once
cloudflared's HTTP/2 stream window stops draining. Backpressure measured only on
`session.clients` would have been inert in exactly the scenario it was written for.

## Decision

**Shape: renderer evaluates, bun caches** (shape (a) of the two considered).

- `src/shared/feature-flags.ts` — flag keys, defaults, and `FEATURE_FLAG_REFRESH_MS`
  (5 minutes). The cadence is one named constant; tune it there, never at a call site.
- `src/mainview/feature-flags.ts` — `initFeatureFlags()`, called from `main.tsx`.
  Subscribes to `posthog.onFeatureFlags` (fires after every successful load,
  including the first) and re-asks via `posthog.reloadFeatureFlags()` on a
  5-minute timer. `src/mainview/posthog.ts` now exposes the flag APIs next to
  `capture`.
- `src/bun/feature-flags.ts` — `isFeatureEnabled(key)`, a synchronous `Map` read,
  fed by the `setFeatureFlags` RPC. The bun process never talks to PostHog.
- `src/bun/pty-server.ts` reads the flag per chunk in `enqueuePtyData`; no await,
  no network call, no lookup beyond the `Map` get.
- `src/bun/pty-backpressure.ts` — the pure window math, plus `isBackedUp`.
- `registerBackpressureProbe(sessionKey, probe)` in `pty-server.ts`, registered by
  `proxyToPty` in `remote-access-server.ts` for the tunnel-facing socket and
  injected through `StartOptions` like `getPtyPort`. Without it the backpressure
  half of the flag would measure nothing but loopback.

**bun owns one distinct id per install** (`src/bun/analytics-identity.ts`, stored
as `GlobalSettings.analyticsDistinctId`). posthog-js mints an anonymous id per
renderer and keeps it in *that renderer's* `localStorage`, so the desktop window
and a remote browser were two persons of the same machine — a percentage rollout
would bucket them independently and half-enable the install. Now:

- The remote HTML shell carries `window.__DEV3_DISTINCT_ID__`, injected next to
  the existing theme bootstrap (`injectInitialThemeBootstrap`). posthog-js reads
  it at init as `bootstrap.distinctID` with `isIdentifiedID: false`, which is
  synchronous — an RPC round trip would land after init.
- `bootstrap.distinctID` applies only when a renderer has no persisted identity,
  which is exactly the desired precedence: the desktop renderer keeps the id it
  already had, and bun *seeds itself from that same id* on first run
  (`resolveAnalyticsDistinctId({ seed })`). An existing install therefore keeps
  its person instead of splitting into a second one.
- No `identify()` call. It would guarantee unification but converts an anonymous
  person into an identified one, changing person semantics and billing for the
  sake of flags. Seeding achieves the same id with none of that.

**Only the Electrobun renderer refreshes flags** (`initFeatureFlags` returns
early otherwise). Not for identity any more — that is shared — but for cost: one
poller per install regardless of how many browsers are attached, and no
last-writer-wins race between renderers pushing into bun.

**Defaults, every gap named:**

| Situation | Value bun serves |
|---|---|
| Before the first successful fetch | `FEATURE_FLAG_DEFAULTS` — every flag off |
| PostHog unreachable | last known value; posthog-js serves its own cache, the renderer keeps pushing it |
| No PostHog key configured | flags off — the no-op client reports every flag unset |
| Renderer not up yet | flags off |
| bun has no stored distinct id yet | the HTML shell omits `__DEV3_DISTINCT_ID__`; that renderer falls back to its own posthog-js id and offers it as the seed |
| Renderer timers throttled (window hidden or minimized) | last known value, held indefinitely |
| Key absent from a push payload | last known value — only an explicit `false` turns a flag off |

Off means "the behaviour the app already shipped", so an install that never reaches
PostHog behaves exactly as it did before this change.

`reloadFeatureFlags()` is deliberately fire-and-forget: it is neither awaitable nor
reactive, and the cached value keeps being served while a refetch is in flight.
Holding the last known value across an outage is the behaviour we want, stated
here so it is not mistaken for an oversight.

**One flag covers both fixes.** Splitting them would let an install get the
leading-edge flush without backpressure — the worst combination, since faster
flushing raises message rate on an unthrottled socket.

**Mid-session flips are safe for these two fixes specifically.** Both change only
*when* bytes are sent, never the bytes or the wire format, so a live PTY session
crosses a flag change without corrupting the screen. This is a property of these
two changes, not a general guarantee — the next flag must argue its own case.

**Nothing is ever dropped.** The ANSI stream is stateful, so a discarded chunk
corrupts the screen. Under backpressure output waits in `session.pendingData` and
is coalesced; the window widens to at most 250 ms.

**Removal plan.** `AGENTS.md` forbids deprecation, and this flag is a deliberate
temporary exception. End state: once the flag has held at 100% for one release
cycle with no latency or backlog reports, delete the `remoteTerminalLatency` entry
from `FEATURE_FLAGS`/`FEATURE_FLAG_DEFAULTS` and the `isFeatureEnabled` branch in
`enqueuePtyData`, leaving the leading-edge + backpressure path as the only path,
and archive the flag in PostHog. The plumbing (`shared/bun/mainview` feature-flags
modules and the RPC method) stays — it is the reusable pattern. If the flag is
killed instead, the same deletion runs with the branches swapped.

## Risks

- **Up to 5 minutes to kill.** Accepted; PostHog offers nothing faster, and
  shortening the interval multiplies cost per install without buying "instant".
- **`pendingData` is unbounded** while a window is widened. Bounded in practice by
  output rate over at most 250 ms, and the alternative (dropping frames) corrupts
  the screen.
- **The tunnel-facing buffered amount is a proxy for real link congestion**, not a
  measurement of it. It depends on cloudflared propagating HTTP/2 flow control to
  its local TCP read. Verified by reading, not instrumented — there is no terminal
  round-trip instrumentation anywhere in the codebase, so the end-user signal for
  this change is "it feels faster", stated plainly.
- **Property changes auto-trigger a flag reload in posthog-js.** Audited: no code
  path sets person or group properties on a timer or per action, so nothing
  multiplies the 5-minute poll today. A future `setPersonProperties` on a hot path
  would silently do so.

## Alternatives considered

- **`posthog-node` polling from bun** (shape (b)). Self-contained, but needs the
  project key plumbed into the bun process — no mechanism exists
  (`src/shared/electrobun-build-env.ts` is about build archives, not env
  injection) — and introduces a second distinct id, so a percentage rollout could
  half-enable one machine.
- **Local evaluation.** Rejected outright: a personal API key in a desktop app.
- **Our own SSE/WebSocket channel** feeding `updateFlags()` with
  `advanced_disable_feature_flags: true`. The only shape that would be genuinely
  push-based, and it needs a backend dev3 does not have. Rejected, not overlooked.
- **Letting each renderer keep its own posthog-js id.** What shipped first, and
  wrong: two ids for one machine, so a percentage rollout could enable the
  desktop window and not the browser. Caught by the user before release.
- **`identify(installId)`.** Unifies unconditionally, but creates an identified
  person for a machine, not a user.
- **Backpressure measured only on `session.clients`.** Simplest, and inert over the
  tunnel — see Investigation.
- **Dropping frames under pressure.** Forbidden: the ANSI stream is stateful.
- **Two flags, one per fix.** Rejected — see the one-flag reasoning above.
