# 057 — Stuck-preparation popover: anchored, macOS-only, env-configurable

## Context

When the `fetching-origin` clone phase hangs for a long time, the symptom looks like a network or auth issue. On macOS the real cause is almost always Full Disk Access being silently revoked for git/tmux child processes spawned by the bundled app. README documents the workaround, but users were staring at a frozen progress bar instead of being told.

A previous iteration shipped a centred blocking modal (`StuckPreparationModal`) that triggered after 3 minutes and was visible on every OS. It worked but did not match the spec: blocking modal, threshold too long, no Cancel passthrough, ESC + click-outside dismissal, and shown on Linux/Windows where the FDA advice is irrelevant.

## Decision

Replaced the modal with `src/mainview/components/StuckPreparationPopover.tsx`, a `position: fixed` portal anchored to the stuck task card via `[data-task-id]` querySelector + `getBoundingClientRect`. The popover prefers right of the card, falls back to left, and finally below; vertical/horizontal clamping keeps it on-screen. Re-measured on scroll, resize, and every 250 ms while the card is alive.

Default threshold dropped from 180 s to 60 s (`STUCK_PREPARATION_FETCH_THRESHOLD_MS` in `src/shared/types.ts`). The bun side reads `DEV3_STUCK_PREP_THRESHOLD_SEC` once at startup and exposes it via the new RPC `getStuckPreparationThresholdMs` (see `src/bun/rpc-handlers/app-handlers.ts`); the renderer fetches it on mount and falls back to the constant on error. There is no UI for this — it is an escape hatch for slow/large repos, not a normal user setting.

Popover is rendered only when `navigator.platform` matches Darwin. Cancel maps directly to `api.request.cancelTaskPreparation`, identical to the existing X-button on the card. Open Full Disk Access calls the existing `openSystemSettings({ pane: "fullDiskAccess" })` RPC, which deep-links to `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`. Both buttons dismiss the popover for the rest of the session for that task; ESC and click-outside do not.

## Risks

- `getBoundingClientRect` is polled at 250 ms; cheap but not free. Only runs while a stuck task is detected, so cost is bounded.
- Per-session dismissal is in-memory — restart shows the popover again. Acceptable; the user should fix or cancel rather than dismiss.
- `navigator.platform` is deprecated. We use it because Electrobun does not expose a typed platform helper in the renderer, and the fallback (no popover) is safe. Test seam `forcePlatformMac` lets us cover the macOS branch without hijacking the global.

## Alternatives considered

- **Inline the FDA warning into the existing per-card preparing overlay (option A).** Cleaner visually but requires gutting TaskCard's preparing block and ships fewer test seams. Rejected as a larger blast radius for the same outcome.
- **Keep the centred modal and just patch threshold/cancel/auto-dismiss (option C).** Cheapest but violates the "near the task card" requirement and blocks the rest of the board. Rejected.
- **Project-level setting for threshold.** Discussed; the override is needed once in a blue moon (Linux clones of huge repos), not per-project. Env var keeps the surface area zero.
