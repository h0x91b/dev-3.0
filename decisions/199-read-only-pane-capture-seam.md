# 199 — Read-only pane capture is a seam method, and native reports `not-enabled`

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
dead, not merely thin. Turning the parser on costs roughly 90–107 MB of host RSS
per pane plus the snapshot write volume decision 169 budgets, and lazy activation
cannot reconstruct an exact screen from the middle of a control sequence.

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
  read and compare an opaque `incarnation` (a digest of the pane's processes) and
  `epoch` (the coordinator's generation; unknown on tmux, which publishes none).
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
- **Native reports `not-enabled` in production, honestly.** `liveParser` stays
  off. A pane whose host published no snapshot and is older than a 3s
  first-write grace window reports `not-enabled` with a reason; inside that window
  it reports `unavailable`, so a booting pane is never mislabelled as permanently
  incapable. Enabling the parser — or a cheaper compact host-side projection — is
  the next kill-tmux decision, not part of this change.

## Risks

**Native parity is contractually complete but operationally empty.** Every
production native pane returns `not-enabled` today. This must not be read as
"native capture works"; the seam is correct and proven against a real host with
the parser on, and the activation decision is still open.

**`not-enabled` leans on a 3s heuristic.** A host that takes longer than 3s to
publish its first snapshot would be reported `not-enabled` for a moment. The
parser's own debounce is 250 ms, so the window is generous, but it is a heuristic
rather than a recorded fact — the record does not say whether a host runs a
parser. Recording it would remove the guess.

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
- **Enable `liveParser` for every native pane now** — 90–107 MB RSS per pane plus
  the snapshot write volume, decided without measuring aggregate CPU/IO or
  auditing restart and upgrade behaviour.
- **Activate the parser lazily on first capture** — it cannot reconstruct the
  screen it missed, and arriving mid-control-sequence yields a wrong screen rather
  than a late one.
- **Promote the Seq 1185 journal** — decision 146 already ruled it out: it grows
  with session lifetime and replay cost grows with total historical output.
