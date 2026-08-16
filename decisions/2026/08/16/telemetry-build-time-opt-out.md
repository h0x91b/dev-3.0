# Telemetry opt-out is a build-time flag, defaulting to on

## Context

Two analytics channels ship in the renderer — GA4 through the Measurement Protocol
(`src/mainview/analytics.ts`) and PostHog (`src/mainview/posthog.ts`) — and neither had any way
to turn off. People who build from source, and distributions that repackage the app, need a
switch they can prove is off, not a runtime setting a future release could quietly reset.

## Investigation

Gating only the GA transport is not enough. `sendToGA` carries the seven event types, but
`initAnalytics` separately fires the `api.ipify.org` lookup that supplies `ip_override`, starts
the 10-minute heartbeat interval, and installs the global `error` / `unhandledrejection`
listeners — none of which pass through `sendToGA`. PostHog needs its own gate because it turns
itself on from build-time keys the release workflows inject, so "leave the key unset" is not a
switch a downstream builder controls.

## Decision

One flag, `VITE_TELEMETRY`, read through `telemetryEnabled()` in `src/mainview/telemetry.ts`:
anything other than the literal `off` means on, so an absent variable keeps today's behaviour
exactly. `off` early-returns from both `sendToGA` and `initAnalytics`, and forces `posthog.ts`
onto its existing no-op client regardless of `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST` — which also
suppresses the DEV-mode "key missing" throw, since a build that asked for no telemetry is not
misconfigured. The flag is read per call rather than captured in a module constant so
`vi.stubEnv` can flip it in tests; Vite still constant-folds it, and a `VITE_TELEMETRY=off`
bundle compiles the helper down to `return !1` with both entry points returning before any
network call.

## Risks

Feature flags stop being served when telemetry is off and fall back to `FEATURE_FLAG_DEFAULTS`
in `src/shared/feature-flags.ts` — the same path a keyless source build already takes, so it is
supported rather than new. `posthog-js` is still statically imported and therefore still in the
bundle when off; it is never initialized, and removing it would mean making the module's export
async. The default being on means the flag protects nobody who does not set it, which is the
deliberate trade for leaving released builds untouched.

## Alternatives considered

A runtime settings toggle would be discoverable but leaves the code paths live and depends on
the setting surviving every future migration. Honouring `DO_NOT_TRACK` / `navigator.doNotTrack`
would change behaviour for existing users without them asking, which is exactly what the default
is meant to avoid; the build-time flag can be composed with either later.
