# 175 — Pace SGR mouse reports so a fast scroll cannot overrun the PTY read window

## Context

Scrolling fast through a long Claude Code session periodically pasted garbage
into its input box: `5;68;43M`, `<64;69;44M<64;69;44M`, `;25M` — fragments of
SGR mouse reports, some whole, some missing their leading `ESC [ <`.

`TerminalView`'s wheel handler emits one report (`\x1b[<65;col;row M`, ~12
bytes) per accumulated scroll line, with no cap: a single momentum flick could
produce dozens per event, several KB/s in total. Claude Code enables mouse
tracking (`mouse_any_flag`/`mouse_all_flag`/`mouse_sgr_flag` all set on the
pane), so tmux forwards the whole stream straight into its PTY instead of
handling the wheel itself.

## Investigation

A raw-stdin chunk spy running inside tmux, fed bursts of 50/100/200/400 reports
via `tmux send-keys -H`, showed the macOS PTY hands a reader **at most 1022
bytes per read**. Bursts under that arrived intact; anything larger was sliced
at an arbitrary byte offset, and the following chunks began mid-sequence —
`5;10;18M<ESC>[…`, `10;13M<ESC>[…`, `;17M<ESC>[…` — byte-for-byte the shape of
the reported garbage. Separate writes were *not* coalesced while the reader kept
up; the slicing only appears once bytes pile up in the PTY buffer because the
app is busy rendering.

So the split itself is legitimate stream behaviour, and the literal-text paste
is Claude Code failing to carry an unterminated escape prefix across stdin
chunks. What dev3 controls is the volume that makes the split likely at all.

## Decision

`src/mainview/wheel-pacer.ts` — a token bucket (150 reports/s sustained, burst
16) gates the wheel handler in `TerminalView.setupMouseTracking`. Excess lines
are **dropped, not queued**, so an over-fast flick stops where the finger
stopped instead of coasting. A flush is emitted as one `term.input()` write of
repeated sequences (≤ ~192 bytes), and drag motion reports are deduplicated per
cell rather than per pixel.

At 1.8 KB/s the app would have to stop reading stdin for ~570 ms before 1022
bytes accumulate, versus ~200 ms before.

## Risks

The cap is below the peak rate a trackpad flick could previously reach, so an
extreme flick scrolls somewhat less far. 150 reports/s is still far faster than
anything readable. The fix reduces the probability of the slice, it cannot
eliminate it — an app that stalls long enough will still see a split chunk, and
handling that correctly remains the TUI's job.

## Alternatives considered

- **Batch a whole flick into one write** — makes it worse: a single >1 KB write
  is guaranteed to be sliced, while paced smaller writes usually are not.
- **Throttle in `pty-server` instead** — the backend cannot see how far behind
  the reader is either, and it would also delay unrelated keystrokes.
- **Handle the wheel in tmux copy-mode instead of forwarding it** — breaks
  scrolling inside every mouse-owning TUI (vim, less, htop, Claude Code).
- **Leave it to Claude Code** — correct in principle, out of our control, and
  the flood is worth trimming regardless.
