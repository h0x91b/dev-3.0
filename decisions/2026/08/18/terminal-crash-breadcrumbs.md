# Attach the run-up to every terminal crash log line

## Context

Three fixes shipped on 2026-08-18 for the "terminal shows nothing" reports, and all
of them log the MOMENT of failure: the error, the dimensions it threw on, the byte
and frame counters. None of them logs the seconds before it. Successful resizes were
never recorded at all, so the one claim both field reports make — that a resize
triggered it (a resolution change, an artifact pane being dragged) — cannot be
confirmed or killed from a log file. The crash arrives roughly every other day, so a
missed occurrence costs a day or two of waiting.

## Decision

`src/mainview/terminal-breadcrumbs.ts` — a bounded per-terminal ring of the last 16
events (`open`, `resize`, `resize-observer`, `dpr`, `hidden`, `visible`,
`frame-error`), formatted with times relative to the crash and attached as `trail`
to every error payload in `TerminalView.tsx`: both render-guard callbacks, all three
refit catches, and the write/socket catches.

Consecutive identical events collapse into a count (`-4.0s→-0.1s resize 158x82 x40`)
rather than occupying 40 slots. That is not only compression: a resize storm is
itself a trigger signature, and without collapsing it would flush the older, more
interesting entries out of the ring.

A module-level `session` object (`liveTerminals`, `frameErrorPanes`, `crashes`) rides
along in the same payloads. Every terminal shares ONE ghostty WASM module, so the
first question a post-mortem asks is whether one pane broke or the module did — and
no per-pane number can answer that.

## Risks

The trail lives in memory and dies with the pane, so a crash whose diagnostics never
reach the backend (dead RPC bridge, decision 199) loses it too. The ring is written
on every successful resize, which is the hot path — hence a plain array push with an
early collapse and no allocation per frame.

## Alternatives considered

- **Log every successful resize at `info`.** Would have answered the same question,
  but a resize drag emits dozens per second into a shared log file, and it still
  would not tie the run-up to the crash line.
- **Wait for the next occurrence and read the existing lines.** They cannot answer
  it: that is precisely the gap this closes.
- **Ship the trail to analytics instead.** The log file survives a restart and is
  what the user can hand over; analytics needs a live network and a query.
