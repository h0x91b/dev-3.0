# One push helper in the desktop entry, so remote clients stop missing events

## Context

The desktop process serves two audiences at once: its own Electrobun windows, and whatever browser is
attached over the remote-access server (a phone, a laptop on the LAN, a Cloudflare tunnel). `dev3 remote`
(`src/bun/headless-entry.ts`) has no windows, so it pushes everything with `pushToBrowserClients`. The
desktop entry (`src/bun/index.ts`) wired the same hooks by hand with `broadcastToAllWindows`, and only some
of those call sites also pushed to browsers.

## Investigation

Reproduced on a real remote client (seq 1745): a QA-scoped board served by the desktop host, driven in a
browser. Killing the task's tmux session left the browser showing a bare `[exited]` in an empty terminal
canvas, unchanged 53 s later — no "Terminal session ended" card, no Resume button, and nothing that
self-corrects (the "fallback timeout for cases where ptyDied doesn't fire" in `TaskTerminal.tsx` is an empty
`setTimeout`). Dispatching `rpc:ptyDied` by hand in that same tab rendered the full session-ended card
immediately, which proves the renderer half was never the problem — only the push was missing.

Grepping every call site showed it was not one event but a seam: four wiring blocks plus the updater pushed
to windows alone — `ptyDied`, `projectPtyDied`, `portsUpdated`, `devServerUpdated`, `resourceUsageUpdated`,
`systemMemoryUpdated`, `agentRateLimitsUpdated`, `updateAvailable`, `updateDownloadProgress`. Headless sends
every one of them to browsers, so a phone attached to the desktop app was strictly worse off than the same
phone attached to `dev3 remote`.

## Decision

`src/bun/push-targets.ts` exports `pushEverywhere(name, payload)`, which calls `broadcastToAllWindows` and
`pushToBrowserClients` in turn. Every push in `src/bun/index.ts` goes through it; the entry no longer imports
either single-audience helper. The updater's two events are included deliberately, for parity with headless.

`src/bun/__tests__/push-targets-wiring.test.ts` fails if a bare `broadcastToAllWindows` or
`pushToBrowserClients` call reappears in `index.ts`, in either direction, and
`src/bun/__tests__/push-targets.test.ts` proves the helper reaches both targets. `index.ts` cannot be
imported by a test — Electrobun APIs, top-level await, it opens a window — so the chain is deliberately
proved in those two halves rather than end to end.

## Risks

Remote browsers now receive events they never saw: resource-usage and rate-limit ticks add WebSocket traffic
to a phone (small payloads on an existing socket, and the same traffic headless has always sent), and
`updateAvailable` can now prompt a remote viewer about a desktop-side restart. `sendToFocusedWindow` stays as
it is — it answers a click in one particular window (the update-check outcome) and has no remote counterpart.

## Alternatives considered

Fixing `ptyDied` alone: smallest diff, but it leaves six events broken and nothing stops the next hook from
repeating the mistake. Routing the hooks through the already-wired `getPushMessage()`: no new module, but it
adds a debug log per resource tick and drags init order into it. Unifying the desktop and headless wiring
into one shared module: kills the drift at the root, but it is a large diff across the two riskiest boot
files and changes headless behaviour nobody reported a problem with.
