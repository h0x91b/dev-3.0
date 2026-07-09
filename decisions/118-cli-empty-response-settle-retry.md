# 118 — CLI settle-retry for empty socket responses (dev-server stop/restart)

## Context
`dev3 dev-server stop`/`restart --wait` intermittently exited with
`error: Empty response from server`, even though the operation had partially or
fully happened: restart had stopped the old server but "never brought it back"
(recovery needed a separate `start --wait`), and stop returned non-zero while
`status` confirmed the server was in fact gone a beat later. The non-zero exit
could not be trusted in scripts (merged from two vents, 2026-07-04 / 2026-07-06).

## Investigation
The error originates in `sendOnce` (`src/cli/socket-client.ts`): the socket
`end`s carrying zero bytes, so the CLI concluded "empty response". This is a
RESPONSE-phase transient — the socket connected and the app accepted, but the
in-flight connection was dropped mid-request during the tmux socket handoff of
`stop`/`restart` before any JSON line was written. The retry loop only
re-attempted CONNECT-phase codes (`ECONNREFUSED`/`ENOENT`/`EAGAIN`), never an
empty response, so a single handoff hiccup surfaced as a hard failure. The exact
app-side trigger for the empty close during handoff was not fully root-caused;
the fix is at the layer that is confirmed wrong (the missing retry) and is
self-healing regardless of the precise cause.

## Decision
`sendRequest` now throws a distinct `EmptyResponseError` and, when the caller
passes `retryEmptyResponse: true`, wraps the connect-retry loop in a short
settle-and-retry window (`DEFAULT_EMPTY_RESPONSE_ATTEMPTS = 3`,
`EMPTY_RESPONSE_SETTLE_MS = 200`) before giving up with the same
`Empty response from server` message. `src/cli/commands/dev-server.ts` opts in on
every `devServer.*` request and the `--wait` status poll. This is safe because
all four ops are idempotent — `start`/`restart` re-kill any live session before
starting (`runDevServer`, tmux-pty.ts:790), `stop`/`status` are no-ops when
already gone — so a replay never double-applies. Restart is now effectively
atomic: the CLI keeps trying until it gets a real status, then `--wait` verifies
the port is open (`waitForDevServerReady`); a genuine start failure still surfaces
the clear "exited before opening a port" / "did not open a port within Ns" error.

## Risks
- Opt-in only: non-idempotent mutations (e.g. `task.create`) still fail fast on an
  empty response, so a lost reply is never silently replayed into a duplicate.
- On a truly wedged app the retry re-runs the multi-second restart up to 3×; this
  only happens on the rare handoff-failure path and stays within the 30s per-attempt
  socket timeout.

## Alternatives considered
- **Generic empty-response retry in `sendRequest`** — rejected: would risk
  double-applying non-idempotent mutations if the reply was lost after the app
  processed the request.
- **Hardening only the app side** — deferred: the empty-close mechanism during the
  handoff was not confirmed, so a speculative server change could miss the case;
  the CLI retry fixes it regardless and can layer with an app-side fix later.
