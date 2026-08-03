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

**Turning it on is expensive, measured rather than assumed — and the cost is the
JSON, not the parsing.** `__tests__/capture-cost.bun-e2e.ts` runs every
configuration with identical panes and identical shell load across three arms —
parser off, parser on publishing the per-cell `parser-state.json`, and parser on
publishing the compact projection — and reports only the delta, because the
absolute figure measures the machine. macOS arm64, Bun 1.3.14, 120×40 panes, 8s
window after a 2s warmup, flood paced at 100 lines/s/pane:

| Panes | Load | Arm | Host RSS off → on | Δ/pane | Host CPU | Published | Artifact |
|---|---|---|---|---|---|---|---|
| 1 | idle | snapshot | 51.2 → 76.9 MiB | +25.7 MiB | 0.1% → 0.1% | 0 | — |
| 1 | idle | projection | 51.2 → 70.7 MiB | +19.5 MiB | 0.1% → 0.1% | 0 | — |
| 1 | flood | snapshot | 60.3 → 125.9 MiB | +65.5 MiB | 2.2% → 3.0% | 315 KiB/s | 2 549 KiB |
| 1 | flood | projection | 60.3 → 82.5 MiB | +22.2 MiB | 2.2% → 2.9% | 0.6 KiB/s | 4.9 KiB |
| 4 | idle | snapshot | 204.9 → 383.1 MiB | +44.5 MiB | 0.5% → 0.5% | 0 | — |
| 4 | idle | projection | 204.9 → 292.1 MiB | +21.8 MiB | 0.5% → 0.5% | 0 | — |
| 4 | flood | snapshot | 238.1 → 1111.8 MiB | +218.4 MiB | 7.0% → 30.7% | 14 364 KiB/s | 4 727 KiB |
| 4 | flood | projection | 238.1 → 462.0 MiB | +56.0 MiB | 7.0% → 14.7% | 17.7 KiB/s | 6.6 KiB |
| 6 | idle | snapshot | 305.9 → 587.7 MiB | +47.0 MiB | 0.5% → 0.7% | 0 | — |
| 6 | idle | projection | 305.9 → 440.8 MiB | +22.5 MiB | 0.5% → 0.7% | 0 | — |
| 6 | flood | snapshot | 355.7 → 1735.6 MiB | +230.0 MiB | 10.1% → 48.4% | 23 332 KiB/s | 4 770 KiB |
| 6 | flood | projection | 355.7 → 706.1 MiB | +58.4 MiB | 10.1% → 22.4% | 27.0 KiB/s | 6.2 KiB |

Cadence held at p50 ≈ 1 000 ms in both parser arms, exactly the ceiling decision
169 set. On six busy panes the projection is **4× less resident memory
(+350 MiB vs +1 380 MiB), half the CPU (22.4% vs 48.4%), and ~860× less written
(27 KiB/s vs 23 MiB/s)** — the artifact goes from 4.8 MiB to 6.2 KiB. The residual
+58 MiB/pane is the parser itself: Ghostty's WASM heap and its scrollback. That is
the number the three-arm split was for, and it is what an activation decision has
to weigh — the multi-MiB JSON was never the parsing, it was the shape of what got
persisted.

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
- **Two producer surfaces, one consumer.** `capabilities.capture` names which
  artifact a host publishes: `semantic-snapshot-v1` (the per-cell
  `parser-state.json`) or `plain-text-capture-v1` (the compact `capture.json` —
  physical rows, health, producer identity, bounded to the seam's own 256 KiB).
  In projection mode the per-cell state is neither serialised NOR built:
  `LiveParserCore.project()` allocates row strings instead of an object per cell,
  and the pipeline dedups on those rows, so the cost disappears rather than moving.
  The seam reduces both surfaces to one observation, and a conformance test asserts
  they answer identically for the same pane. The compact record also names its own
  producer, so rows written by a previous incarnation are caught directly, not only
  by the second ownership sweep.
- **Native reports `not-enabled` from a FACT, not a timer.** The record gained
  optional `capabilities.capture`, written by the host only while its live parser is
  actually running (`host.ts` `persist()` passes
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
- **No staleness is inferred from age.** There is no age threshold anywhere in
  the contract. `lastChangeAgeMs` is plain data — how long ago the content last
  changed — and `freshness` is a separate fact a backend must be able to prove:
  `current` for a backend that reads the pane itself (tmux), `unknown` for one
  that reads what a producer wrote on change, because a quiet pane and a wedged
  producer are indistinguishable without a heartbeat. The measurement made the
  first draft's mistake concrete: an idle parser-enabled pane sits at ~6 s within
  seconds of falling quiet, and its screen is perfectly correct. The `stale` issue
  code survives for a producer that gains a heartbeat; nothing emits it today.
- **Trailing blank rows are trimmed once, at the seam**, not per surface. An
  80×24 pane showing three lines is three rows on every backend and every producer
  surface — a per-producer choice here is exactly how two surfaces start disagreeing
  about the same pane.

## Risks

**Native parity is contractually complete but operationally empty.** Every
production native pane returns `not-enabled` today, and `liveParser` remains off.
This must not be read as "native capture works": the seam is correct and proven
against real hosts on both producer surfaces, and the activation decision is still
open. The projection makes activation affordable; it does not make it decided.

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
- **Enable the per-cell snapshot for every native pane** — measured at
  +218–230 MiB RSS per pane, ~48% of a core, and 23 MiB/s of writes across six busy
  panes. It fails the production bar, which is what motivated the projection.
- **Keep one producer surface and shrink the snapshot in place** — the per-cell
  state is the reconnect contract (decision 146); narrowing it would degrade
  reconnect fidelity to serve a capture that does not need cells at all. Two
  surfaces, one consumer vocabulary, is the smaller change.
- **Derive the compact rows in the READER from the per-cell snapshot** — the
  producer would still allocate and write multiple MiB per pane per second. The
  cost is in publishing, so the projection has to happen before the write.
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
