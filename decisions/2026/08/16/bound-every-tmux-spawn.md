# Bound every tmux spawn, with a default timeout on the client

## Context

A user's app (v1.44.0, macOS, bundled tmux 3.6a) froze at startup on the
"Checking system…" bootstrap phase and never recovered. Reload and Retry both
re-armed the freeze. It had been stuck for ~20 minutes when reported.

## Investigation

The user's log named the hang precisely: `checkSystemRequirements` logged
`-> checkSystemRequirements`, `git: found` and `tmux: found`, then neither
`tmux binary set to` nor `<- checkSystemRequirements`. 13 invocations, 2
completions. The only await in that gap is `commitTmuxBinary` →
`selectTmuxBinary` → `probeTmuxServer`, which spawned
`tmux -L dev3 display-message -p '#{version}'` and did a bare
`await proc.exited`. A tmux client whose server does not answer never exits, so
that RPC never settled; `App.tsx` holds `reqStatus === "checking"` until it
does.

That was the hang, but not the cause. A process listing from the machine showed
**1323 tmux client processes, all in state `R`** — spinning, not blocked —
overwhelmingly `capture-pane` from the pane pollers, accumulated at ~250/min
between 14:57 and 15:02, then stopping exactly when the app itself wedged. They
saturated the machine: the app's event loop stalled 0.5–31s, and the tmux
server's own response time went from 4ms to 20–55s, with 3 of 7 commands never
answering.

`capturePane` reaches `run()` through `runChecked` with no bounds. Only 2 of
~37 call sites in `TmuxClient` passed a timeout, so essentially every tmux
command in the app was unbounded — which is what let a slow server convert
routine polling into an unbounded process pile, which then made the server
slower still. `binary.ts` was worse: its three probes bypass `TmuxClient`
entirely and spawn tmux directly.

The bundled binary is 3.6a, so the existing `KNOWN_BAD_TMUX_VERSION` warning
(tmux 3.7 busy-spin) correctly did not fire. What pushed this 3.6a server into
degradation was not determined; the pile-up is self-reinforcing once started,
and bounding it does not depend on knowing the trigger.

## Decision

Bound every tmux spawn.

- **New `src/bun/tmux/bounded-spawn.ts`** holds the one implementation of
  "collect a process's output, kill and reap it if it overruns". The machinery
  (`settled` / `until` / `readUntil` / TERM-then-KILL) moved out of `client.ts`
  verbatim; `TmuxClient.run` now delegates to it and keeps only the tmux-shaped
  error wrapping.
- **`TmuxClient.run` applies `DEFAULT_RUN_TIMEOUT_MS` (10s)** when the caller
  passes no bound. This is the change that caps the pile: a reaped
  `capture-pane` costs one missed pane refresh, and the poller retries.
- **`binary.ts` probes are bounded at `PROBE_TIMEOUT_MS` (3s)**. A server that
  does not answer now returns the new `"unreachable"` status, deliberately
  *not* `"mismatch"` — "no answer" is not evidence of version skew, and
  reporting it as skew would send `selectTmuxBinary` hunting for a fallback
  binary and tell the user to `kill-server` over a version nobody ever read.
  `unreachable` keeps the preferred binary and logs a warning.
- **`warnIfKnownBadTmux` no longer spawns at all** — `selectTmuxBinary` already
  probed that binary's version, so it is passed in.

## Risks

- 10s is a judgement call, not a measurement. On a heavily loaded machine a
  legitimate command could now fail where it previously waited. That is the
  intended trade: a failed poll is recoverable, an unbounded pile is not. The
  bound is per-call and overridable.
- A reaped client leaves the server's own view of that command undefined. All
  bounded calls here are reads or idempotent sets, so a retry is safe.
- `probeTmuxVersion` timing out makes `selectTmuxBinary` report tmux as not
  installed. That is a wrong diagnosis, but a visible one, and strictly better
  than an infinite spinner.

## Alternatives considered

- **Only fix `probeTmuxServer`.** Cures the visible freeze and leaves the cause
  — the unbounded `capture-pane` pile — in place.
- **Bound each call site individually.** ~37 edits, and the next added method
  starts unbounded again. A default on `run()` is the only version that stays
  true.
- **Cap concurrent tmux spawns instead of timing them out.** Queues the
  spinners rather than reaping them; the app still stops refreshing panes and
  the wedged clients still hold their sockets.
- **Treat a timed-out server probe as `"mismatch"`.** Reuses an existing status
  and needs no new branch, but produces an actively misleading "run
  `kill-server`" instruction built on a version string that was never read.
