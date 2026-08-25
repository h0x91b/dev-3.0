# Runtime telemetry opt-out, resolved by the host before the page loads

## Context

An outside privacy audit of the shipped v1.48.0 build found that telemetry was on,
unconditional, and could not be turned off. `VITE_TELEMETRY=off` was documented as the
kill switch, but it is a build-time variable: in a release binary it is unset, so
`["off","false","0","no"].includes("")` constant-folded to `false` and the gate could only
ever return "telemetry is on". The claim in the README — that telemetry is removable — was
technically true and practically useless, because it required rebuilding from source and
gave up the signed cask and the auto-updater.

The same audit found two leaks that an opt-out alone would not fix, because they affect
everyone who never flips the switch: PostHog autocapture shipped with `mask_all_text` and
`mask_all_element_attributes` at their `false` defaults, and this app renders task titles
and project names as `<button>` text and in `title` / `aria-label`; and `capture_exceptions`
was forced on in `posthog.init`, overriding the project's own server-side
`autocaptureExceptions: false`, on a channel whose free-form strings routinely embed
absolute paths.

## Investigation

Verified against posthog-js 1.407.2's own types (`@posthog/types/dist/posthog-config.d.ts`):
`mask_all_text` and `mask_all_element_attributes` are documented booleans defaulting to
`false`, and `capture_exceptions` is `@default undefined`, meaning the remote config decides
when we pass nothing. The audit's reading was correct on all three.

The timing constraint drove the design: `src/mainview/posthog.ts` calls `posthog.init` at
module import, so any verdict fetched over RPC arrives after the first events are already on
the wire. The only place early enough is the HTML shell, which already carries the theme and
the distinct id through the same mechanism.

## Decision

A pure reducer, `resolveTelemetryOptOut` in `src/shared/telemetry-consent.ts`, answers from
`DEV3_TELEMETRY`, `DO_NOT_TRACK` and the stored `telemetryDisabled` setting; any one of them
opting out is enough, and the environment is reported first so the UI can name what it cannot
change. `telemetryBootstrapScript()` (`src/bun/analytics-identity.ts`) runs it at startup and
injects `window.__DEV3_TELEMETRY_OPT_OUT__` into both renderers — the desktop preload and the
remote server's HTML. It replaces `distinctIdBootstrapScript()`, and an opted-out install
ships **no distinct id at all**: the id is only useful to a channel that is now off, and that
same shell is served to unauthenticated browsers.

`telemetryEnabled()` (`src/mainview/telemetry.ts`) now folds three layers — build time, the
injected host verdict, and a runtime override set by the Settings toggle. Switching off is
immediate: GA asks per send, and the toggle handler calls `posthog.opt_out_capturing()` and
`destroyAnalytics()`. Switching back on needs a relaunch, and the UI says so.

Alongside it: `mask_all_text` / `mask_all_element_attributes` are on, `capture_exceptions` is
gone from `posthog.init`, and `redactPaths()` in `src/mainview/analytics.ts` reduces absolute
paths to their basename in the GA copy of every error string while the local log keeps the
original. `disable_session_recording` and `disable_surveys` are pinned in the client too: both
are remote-configurable, so a dashboard toggle on the vendor's side could otherwise start
recording a window that renders source, diffs and live terminal panes with no app update.

## Risks

- **Turning telemetry back on silently does nothing until a relaunch.** Mitigated by saying
  it in the UI rather than pretending the toggle is symmetric; re-initializing posthog-js
  mid-session is the alternative and is a far larger surface for a rarer action.
- **`mask_all_text` costs us autocapture's usefulness** — clicks arrive without their label.
  Accepted: the explicit events we write ourselves are the ones we actually read, and the
  masked properties are the ones we promised never to send.
- **The env var is invisible to an app launched from Finder unless "Import shell environment"
  is on.** Documented in the README; a variable set on the launch command always applies.
- **`redactPaths()` is a regex over free-form text** and will miss an exotic path shape. It
  is a reduction in exposure, not a proof of absence — which is why the setting exists.

## Alternatives considered

- **Read the setting over RPC at boot.** Too late by construction: posthog-js initializes at
  module import.
- **`posthog.opt_out_capturing()` alone, no host gate.** Only covers PostHog; GA4, the ipify
  lookup and the heartbeat would keep running, and posthog-js still initializes and fetches
  remote config first.
- **`autocapture: false` instead of masking.** Simpler and strictly safer, but it also drops
  the rage-click and dead-click signals that are genuinely anonymous. Masking keeps the shape
  of the interaction and discards the text, which is the actual dividing line.
- **Leave the audit's findings and ship only the opt-out.** Rejected: an opt-out protects the
  people who find it, and the README's "names are never sent" claim was made to everyone.
