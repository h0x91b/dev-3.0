# 193 — A native pane closes on SIGHUP, because an interactive PTY shell ignores SIGTERM

## Context

Closing a native task pane took 1.65–1.79 s (seq 1382's measurement, reproduced here at
p50 1662 ms / p95 1770 ms). Decision 192 had already cleared the read/split/layout path,
so the close was the last multi-second action left on the native backend.

## Investigation

`scripts/measure-native-pane-close.ts` attributes one close to named phases
(`classify` / `handshake` / `exitWait` / `forceTerm` / `forceKill`) via a new optional
`onPhase` observer on `registry.stop`. Baseline, real hosts, macOS, idle, n=7:

| phase | p50 |
|---|---|
| classify | 13.5 ms |
| handshake | 2.1 ms |
| **exitWait** | **1720.8 ms** |

The graceful handshake was never slow — it answered in 2 ms. Everything was spent
watching for a shell that was not going to exit.

`host.ts shutdown()` signalled the shell tree with **SIGTERM**, then waited
`Promise.race([proc.exited, delay(1500)])` before escalating to SIGKILL. An
**interactive shell on a PTY ignores SIGTERM**, so that race always lost. Measured
directly against a real zsh:

| shell | signal | exits? | foreground child reaped? |
|---|---|---|---|
| pipes (non-PTY) | SIGTERM | yes, 1 ms | — |
| PTY | SIGTERM | **no**, still alive at 2001 ms | **no** |
| PTY | SIGKILL | yes, 1 ms | — |
| PTY | **SIGHUP** | **yes, 1 ms** | **yes** |

So the graceful path cleaned up neither the shell nor its children; only the SIGKILL
escalation ever retired a pane, and every close paid the full grace window to get there.
The non-PTY row is why this was never caught: every context that spawns the shell on
pipes sees SIGTERM work perfectly.

## Decision

- `host.ts shutdown()` sends **SIGHUP** to the shell and its foreground process group —
  the hangup a PTY shell is built to honour, and what a terminal emulator sends when its
  window closes. `killTree` takes the shell signal and the descendant signal separately;
  descendants keep **SIGTERM**, so a server that traps it gets exactly the notification it
  got before.
- The bounded ladder is unchanged: 1500 ms grace, then SIGKILL, then a 1000 ms settle.
  A shell that traps SIGHUP still stops, just via the fallback.
- `registry.stop`'s exit-observation poll backs off 5 ms → 100 ms instead of a flat
  100 ms tick. Same deadline, same exit condition; the common case no longer pays a whole
  tick to notice an already-dead process. A/B at n=15: close p50 150.6 → 124.0 ms,
  p95 446.5 → 402.7 ms.
- `registry.stop` accepts an optional `onPhase` observer. Off by default and free when
  absent — it exists so the next slow teardown is attributed instead of guessed.

Measured after (same harness, n=15): **close p50 1662 → 124 ms, p95 1770 → 403 ms**.
`exitWait` p50 1720.8 → 80.4 ms, and what remains is genuine host exit work (server
stop, parser flush, journal stop, state removal), not poll granularity.

`graceful-teardown.bun-e2e.ts` locks it in: idle shell and foreground-child cases must
stop inside 800 ms with record, token, host PID, shell PID and the child all gone; the
trap-both-signals case must still stop, must stay inside the 4000 ms fallback bound, and
must exceed the graceful budget — proving force is still the floor and never the first
move. The test was verified to fail on the pre-change code (1640 ms vs the 800 ms budget).

## Risks

- Descendants now have far less wall-clock before the shell goes away, because the shell
  no longer lingers for 1500 ms. That lingering was an accident of the bug, not a
  contract, and a real terminal gives no such window either — but a pane hosting a
  process that relied on a slow SIGTERM death will now be cut short.
- SIGHUP and SIGTERM have the same default disposition (terminate), so only processes
  that explicitly handle one of them can observe the difference at all.
- Windows/ConPTY is untouched: that branch returns before `killTree` and tears down
  through the token-named Job Object exactly as before. The e2e skips on `win32`, so the
  POSIX budgets are not asserted against a platform that does not use this path.
- The 5 ms poll floor raises the syscall rate at the very start of a stop. Bounded — it
  doubles to the same 100 ms ceiling within five iterations.

## Alternatives considered

- **Shorten the 1500 ms grace window.** Treats the symptom: the shell would still ignore
  the signal, and every close would still end in SIGKILL — just sooner. It trades the
  latency for a strictly less graceful teardown.
- **Send SIGHUP to descendants too.** Simpler signature, but it silently changes what a
  trapped-SIGTERM process in the pane receives. Keeping SIGTERM there costs one parameter
  and preserves existing behaviour exactly.
- **Write `exit\r` into the terminal**, as the Windows branch does. Fragile on POSIX: with
  a foreground process running, the text is delivered to that process instead of the shell.
- **Unconditional SIGKILL.** Fastest and wrong — it removes the graceful path the pane
  contract depends on, and would strand descendants that clean up on a signal.
