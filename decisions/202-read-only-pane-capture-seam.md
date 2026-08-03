# 202 — Read-only pane capture is a seam method, and native reports `not-enabled`

## Context

`tmux capture-pane` can read a pane's screen and scrollback without touching the
process in it, and dev3 leans on that in `pty-server.capturePane` →
`getTerminalPreview`. Nothing backend-neutral offered the same thing. The seam
had `TerminalAttachment.capture()` returning `{ viewId, text }`, which is too
thin for a coordination glance (no observation time, no viewport/history split,
no truncation, gap, dead, or stale reporting, no content boundary) and, worse,
required `attachView()` first — a live binding for what should be a read.
Seq 1258 is metadata-only by design and excludes output; Seq 1185 proved snapshot
feasibility but its event journal is explicitly not shippable (decision 146).

## Investigation

Three findings shaped the result.

**Native capture is already non-invasive.** `coordinator.capturePane` reached the
text through `MonotonicSnapshotView` → `readParserState`, i.e. a pure read of
`parser-state.json`. The host publishes that file whether or not a client is
attached, so capture needs no connection, no writer lease, and no protocol
message. It was nevertheless going through `connectPane`, which opened a
WebSocket just to read a file.

**Native production panes have no parser at all.** The host starts its live
parser only under `DEV3_NATIVE_SESSION_LIVE_PARSER=1`, passed via
`StartOptions.liveParser`. `native-terminal-adapter` sets it; the multipane
coordinator — what `NativeTerminalBackend` actually uses — does not. Every
production native pane therefore had `capturePane` returning `""`: capture was
dead, not merely thin.

**Turning it on is expensive, measured rather than assumed.**
`__tests__/capture-cost.bun-e2e.ts` runs every configuration twice — identical
panes and identical shell load, parser off then on — and reports only the delta,
because the absolute figure measures the machine, not the feature. macOS arm64,
Bun 1.3.14, 120×40 panes, 8s window after a 2s warmup, flood paced at 100
lines/s/pane:

| Panes | Load | Host RSS off → on | Δ per pane | Host CPU off → on | `parser-state` written | Snapshot |
|---|---|---|---|---|---|---|
| 1 | idle | 50.6 → 79.0 MiB | +28.3 MiB | 0.1% → 0.1% | 0 | — |
| 1 | flood | 59.3 → 126.6 MiB | +67.3 MiB | 2.1% → 2.7% | 0.31 MiB/s | 2.5 MiB |
| 4 | idle | 203.5 → 381.7 MiB | +44.6 MiB | 0.5% → 0.5% | 0 | — |
| 4 | flood | 238.0 → 1034.8 MiB | +199.2 MiB | 7.1% → 29.9% | 13.73 MiB/s | 4.6 MiB |
| 6 | idle | 304.8 → 585.4 MiB | +46.8 MiB | 0.5% → 0.6% | 0 | — |
| 6 | flood | 351.8 → 1674.6 MiB | +220.5 MiB | 10.1% → 48.5% | 21.52 MiB/s | 4.6 MiB |

Snapshot cadence held at p50 ≈ 1 000 ms, exactly the ceiling decision 169 set, and
observation latency (the seam's own `ageMs`) was p50 3.4–3.9 s / p95 7.1–7.4 s
under flood. Idle costs a flat ~28–47 MiB per pane and no measurable CPU or disk.
Under a busy six-pane task the parser adds **~1.3 GiB of resident memory, half a
core, and 21.5 MiB/s of disk writes** — which is why it stays off until the
activation decision is taken, and why a compact host-side projection is the
alternative on the table.

Lazy activation is not an option: a parser started mid-control-sequence
reconstructs a wrong screen, not a late one.

**The two backends know genuinely different things.** Native can prove dropped
output and parser health; tmux keeps no such account. tmux can report its own
history depth per pane; native's snapshot caps its scrollback (200 rows by
default) against tmux's 3000.

## Decision

Add `captureView(sessionId, viewId, request?)` to `TerminalBackend`
(`src/bun/terminal-backend/capture.ts` holds the vocabulary and all pure shaping;
both adapters implement it). Delete `TerminalAttachment.capture()`,
`TerminalCapture`, and `TerminalCaptureOptions` outright, and rewrite their tests
in the same change — no shim, per the repo's no-deprecation rule.

- **`viewId` is required.** A capture is never aimed by focus.
- **Six availabilities**, not a `null`: `captured`, `session-absent`,
  `view-absent`, `not-enabled`, `unavailable`, `unreadable`, plus `replaced`.
  Identity and `readAt` ride on every one, so a miss is loggable without a second
  call, and only `captured` carries content — reading text off a miss does not
  type-check. A pane that genuinely shows nothing is a `captured` result with
  empty arrays.
- **`readAt` and `sourceUpdatedAt` are separate.** tmux answers synchronously, so
  they are equal; native reads a snapshot persisted on a cadence, so it lags by up
  to ~1s and says so. Conflating them would make every native capture look fresh.
- **Bracketed identity.** Both adapters observe the pane before and after the
  read and compare an opaque `incarnation` and `epoch` (the coordinator's
  generation; unknown on tmux, which publishes none). The incarnation digests the
  host's and shell's **start signatures** alongside their pids — the same evidence
  ownership classification trusts — because pids alone compare EQUAL after pid
  reuse under the same session id. tmux publishes no per-process start time
  (`pane_start_time` is empty), so its incarnation folds in `session_created`, the
  server epoch, which changes exactly when `%N` pane ids begin again.
  A mismatch is `replaced`, so a pane that dies and is replaced mid-read can never
  hand back its successor's screen under the old name.
- **Fixed order of loss.** History beyond the requested line count goes first,
  oldest end first; then history that does not fit the byte budget; then, and only
  then, the viewport's top rows, always with a `viewport-truncated` issue. Every
  cut lands on a whole physical row, so no line and no code point is ever split,
  and budgets are UTF-8 bytes.
- **Capture-owned facts and issues,** not `native-terminal-diagnostics`'
  `DiagnosticFact`. The two contracts stay independent so neither drags the other
  along, even though the fact shape is deliberately familiar.
- **Content boundary.** Plain text only — every escape sequence and control byte
  is stripped at the seam, which is what keeps OSC 52 clipboard payloads, OSC 8
  hyperlink targets, and title strings out of a capture. History is off by
  default, ceilings are 2000 rows / 256 KiB, and no process fact (pid, cwd,
  command, environment) is carried at all.
- **Native reports `not-enabled` from a FACT, not a timer.** The record gained an
  optional `capabilities.capture: "semantic-snapshot-v1"`, written by the host
  only while its live parser is actually running (`host.ts` `persist()` passes
  `publishesSemanticSnapshot: pipeline !== null`). Absence is the load-bearing
  half: it covers both a parser-less host and one built before the field, and both
  mean the same thing — there is nothing to capture. Additive at
  `schemaVersion: 1` on the same terms as `identity`, so an older dev3 parses such
  a record unchanged (its whitelist ignores unknown keys) and an unrecognised
  capability value is dropped rather than rejected, landing on "not enabled",
  which is the safe side. With the capability present but no snapshot yet, the
  answer is `unavailable` — genuinely "not yet". `liveParser` stays off in
  production; enabling it, or designing a compact host-side projection, is the
  next kill-tmux decision.
- **`stale` means "this read cannot vouch that the content is current"**, not
  "the content is old". A synchronous backend (tmux) is never stale. A
  snapshot-backed pane goes stale as soon as it falls quiet past the ceiling,
  because a quiet pane and a wedged producer are indistinguishable from outside —
  the measurement made this concrete: an idle parser-enabled pane sits at
  `ageMs` ≈ 6 s within seconds, and calling that "old content" would have been
  wrong. `ageMs` is documented as the age of the last CHANGE, which for a
  coordinator is usually the more useful number.

## Risks

**Native parity is contractually complete but operationally empty.** Every
production native pane returns `not-enabled` today. This must not be read as
"native capture works"; the seam is correct and proven against a real host with
the parser on, and the activation decision is still open.

**A host that lies about its capability lies to every reader.** The verdict is now
the host's own statement, so a host that advertises `semantic-snapshot-v1` and
then never writes a snapshot reports `unavailable` forever rather than
`not-enabled`. That is the correct failure — an advertised-but-broken producer is
a bug in the host, not something a reader should paper over with a timer.

**tmux identity is weaker than native's.** tmux exposes no per-process start
signature, so a pane whose process is respawned onto the exact same pid within
the same server would compare equal. `session_created` covers the server-restart
case; the residual is narrow and unavoidable with what tmux publishes.

**History depth differs by backend** (tmux ~3000 rows, native ~200). Reported
honestly through `historyLinesAvailable` / `historyLinesOmitted`, not equalised.

**A screen clear or terminal reset cannot be told from history that scrolled
off** on either backend. Reported as an explicit `unknown` issue on every capture
rather than silently missing.

`getTerminalPreview` is deliberately NOT migrated: it renders ANSI-rich output
into a preview, and this seam is plain text by design. Migrating it needs a
separate decision about coloured output, tracked with the remaining
`capture/state` entries in the Seq 1251 inventory (roadmap STATE-008).

## Alternatives considered

- **Keep `TerminalAttachment.capture()` and enrich it** — every caller would
  still have to attach, and an attachment is a write/resize channel. A read must
  not require one.
- **Return `null` for the unavailable cases** — collapses five distinguishable
  answers into one, and "the screen is blank" versus "we did not look" lead to
  opposite decisions.
- **Throw a typed error on mid-read replacement** — hostile for a read-only
  glance a coordinator makes in a loop; `replaced` is just as explicit and needs
  no `try`.
- **One text blob with a marker between history and viewport** — puts the split
  back on the caller to parse, and the marker could appear in real output.
- **Byte-slice the text to the ceiling** — free to halve a multi-byte character
  and to hand back a partial line. Whole rows only.
- **Clamp tmux history to native's 200 rows for "parity"** — throws away real
  capability to make two numbers match, and hides the difference instead of
  reporting it.
- **Enable `liveParser` for every native pane now** — measured at +199–220 MiB
  RSS per pane, ~48% of a core, and 21.5 MiB/s of writes across six busy panes.
  Not a cost to take on before the activation decision weighs it against a
  compact host-side projection.
- **Infer "no parser" from silence plus a grace timer** — what the first draft
  did. It guesses, it is racy on a slow host, and it cannot tell a parser-less
  host from a broken one. A one-field capability turns the guess into a fact.
- **Bump the record schema version for the capability** — would make every
  existing record unreadable to this build and this build's records unreadable to
  every older one. Additive-and-optional is the whole reason the schema survives.
- **Activate the parser lazily on first capture** — it cannot reconstruct the
  screen it missed, and arriving mid-control-sequence yields a wrong screen rather
  than a late one.
- **Promote the Seq 1185 journal** — decision 146 already ruled it out: it grows
  with session lifetime and replay cost grows with total historical output.
