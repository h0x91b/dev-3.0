# Judge a frozen window from the backend, not from inside it

## Context

On 2026-08-19 around 14:17 the UI froze hard. The log (`~/.dev3.0/logs/2026/08/2026-08-19.log`,
pid 84000) held no cause — only a timing signature found afterwards: every
renderer-driven call stopped mid-poll at 14:17:00.911 (the 4.5s `checkDevServer`
loop died between ticks, and no `saveLastRoute` followed, so it was not a route
change), while backend work continued normally for another 59 seconds until the
user quit.

## Investigation

`terminal-render-guard` already watches for a dead ghostty render loop, but it
runs its own `setInterval` **inside the renderer** — a wedged renderer never fires
it, so it cannot see a whole-window freeze. Nothing in the renderer can: its
timers, guards and error handlers are all dead with it.

Corroborating evidence for where the CPU goes, from the same day:
`/Library/Logs/DiagnosticReports/com.apple.WebKit.WebContent_2026-08-19-*.cpu_resource.diag`
(10:29, 11:00, 11:37) all share one heaviest stack — `requestAnimationFrame` →
`CanvasRenderingContext2D::fillText` → CoreText shaping, i.e. the terminal canvas —
at 62–88% CPU with the webview footprint reaching 774 MB. None of them covers
14:17, so they are a pattern, not the captured cause.

## Decision

The backend outlives the freeze, so it does the judging.

- `src/mainview/renderer-heartbeat.ts` — each window beats every 2s
  (`rendererHeartbeat` RPC) carrying only what the backend cannot know: the gap the
  page measured itself, whether that gap spans a hidden stretch, and the live
  terminal counts (now shared via `src/mainview/terminal-session-stats.ts`).
- `src/bun/renderer-watchdog.ts` — `recordRendererHeartbeat` plus
  `startRendererWatchdog` (wired in `src/bun/index.ts` next to `startLoopMonitor`,
  its backend counterpart). Four lines exist: `started` (one positive marker per
  window), `lost`, `resumed`, and `hiccup` for a stall that recovered on its own.
  Each client is tracked separately, because several windows and remote browsers
  beat into one backend.

Log cost is the design constraint, at the user's explicit request: a healthy
session is **one line per window**, and `MAX_HICCUPS_PER_CLIENT = 5` caps repeated
stalls, with the last line flagging `furtherStallsSuppressed` so the silence after
it is not misread.

## Risks

- **False "lost" on a window that is merely throttled.** A hidden window has its
  timers throttled to roughly one tick a minute. Guarded twice: the last beat
  carries `visible` (and the window beats once more on its way out), and a gap that
  spans a hidden stretch is marked `hiddenSinceLastBeat` so it is never called a
  stall. A first live run produced exactly this false positive (a 5.7s "hiccup" on
  an occluded window) before the second guard existed.
- **The `lost` path is not proven end-to-end.** The unit tests cover it, and
  `started`/`hiccup` were observed live, but SIGSTOPping the WebContent process
  produced no `lost` line — most likely because that window was not visible, which
  is the guard above doing its job. Unverified against a genuinely visible frozen
  window.
- A beat every 2s per window is one extra RPC on an idle app.

## Alternatives considered

- **Watch existing renderer traffic instead of adding a beat.** Rejected: that
  traffic is incidental, not periodic by contract, so "quiet" would not mean
  "frozen".
- **A watchdog inside the renderer.** That is what already exists and what failed —
  a wedged thread cannot report on itself.
- **Leave it and read the timing signature by hand each time.** Rejected: it took
  a full investigation to find, and it names no cause.
