# 202 — Read-only pane capture, and its two independent producer artifacts

## Context

`tmux capture-pane` reads a pane's screen without touching the process in it, and
nothing backend-neutral offered the same. The seam's `TerminalAttachment.capture()`
returned `{ viewId, text }`, which cannot express observation time, a
viewport/history split, truncation, loss, or a content boundary — and it required
`attachView()`, a write channel, for what is a read.

## Investigation

Native capture never needed a connection: the text came from `parser-state.json`,
which the host publishes whether or not a client is attached, yet the old path
opened a WebSocket to read a file. It also never worked in production, because the
host runs its parser only when asked and nothing asked.

Measurement then showed the cost is the ARTIFACT, not the parsing. Method and every
raw round live in `__tests__/capture-cost.bun-e2e.ts` and this task's notes; on six
busy 120×40 panes the p50 deltas against `none` were +382 MiB phys_footprint,
29.2% CPU and 14.2 MiB/s written for `semantic`, against +161 MiB, 11.7% and
29.5 KiB/s for `compact` — roughly 2.4× the memory, 2.5× the CPU and 490× the bytes,
all of it spent on colours, cursor and modes a capture discards. Idle costs no CPU
and no writes in any mode. `getScrollbackLine` still allocates a cell array per row,
so the projection avoids the copied semantic state and the multi-megabyte JSON, not
all per-cell allocation.

## Decision

`TerminalBackend.captureView(sessionId, viewId, request?)` (`./capture.ts` holds
the vocabulary and all pure shaping). `TerminalAttachment.capture()` and its types
are deleted, not deprecated.

- **`viewId` required**, so a capture is never aimed by focus, and every outcome is
  a result rather than a `null` or a throw: `captured`, `session-absent`,
  `view-absent`, `not-enabled`, `unavailable`, `unreadable`, `replaced`. Only
  `captured` carries content, a blank pane is a successful empty capture, and
  absence means a SUCCESSFULLY observed absence — a failed probe is `unreadable`.
- **Purely observational**, via a non-reconciling inspection: recovery may stop
  panes and rewrite the coordinator record, a capture may not. Every outcome is
  bracketed by two identity observations — an opaque incarnation digesting the host
  and shell start signatures (pids alone compare equal after reuse; tmux, lacking a
  per-process start time, folds in its server epoch) plus the session epoch — and
  drift is `replaced`. tmux reads its facts and rows in one server turn, because two
  reads can duplicate or drop a row while claiming to be one moment.
- **One exhaustive artifact mode** (`none | semantic | compact |
  semantic-and-compact`) over two INDEPENDENT sinks, so compact can never make the
  legacy per-cell artifact unreachable; `capabilities.capture` advertises surfaces
  as an independent list and a reader prefers compact. Production stays `none`, so
  native reports `not-enabled` from the host's own record, never from a timer.
- **Bounded and honest.** 2000 rows / 256 KiB, applied before the artifact is
  built, one pass per list; loss order fixed (history oldest first, then the
  viewport's top rows with an explicit issue); cuts on whole physical rows; UTF-8
  byte budgets; trailing blank rows trimmed once at the seam. `lastChangeAgeMs` is
  data and `freshness` is `current` only where a backend reads the pane itself — a
  quiet pane is not a stale one — and anything unprovable is unknown-with-reason
  rather than a zero. Plain text only: escape sequences and control bytes, whole
  8-bit C1 sequences included, are stripped, history is opt-in, and no pid, cwd,
  command or environment is carried.

## Risks

Native parity is contractually complete but operationally empty: every production
pane returns `not-enabled` until activation is decided, and `compact` making that
affordable does not make it decided. The compact-only mode rests on a
reachability claim — that no product code consumes the per-cell artifact — held by
a guard test and a frozen N-2 reader fixture rather than by inspection. History
depth still differs by backend (tmux ~3000 rows, native ~200), reported through
`historyLinesAvailable`. A screen reset is indistinguishable from history that
scrolled off on either backend, and is reported as an explicit unknown. Windows is
unmeasured. `getTerminalPreview` is NOT migrated: it renders ANSI-rich output and
this seam is plain text by design, so that needs its own decision (STATE-008).

## Alternatives considered

Keeping `TerminalAttachment.capture()` would force every reader to hold a write
channel. Returning `null` for the unavailable cases collapses five distinguishable
answers, and "the screen is blank" versus "we did not look" lead to opposite
decisions. Throwing on mid-read replacement is hostile for a glance made in a
loop. Byte-slicing to the ceiling would halve a multi-byte character. Enabling the
per-cell snapshot for every pane failed the production bar on measurement; keeping
one surface and shrinking it would degrade the reconnect contract (decision 146),
which genuinely needs cells; deriving the compact rows in the READER leaves the
producer paying the write. Inferring "no parser" from silence plus a timer guesses,
races a slow host, and cannot tell a parser-less host from a broken one. Bumping
the record schema for the capability would make every existing record unreadable
in both directions; additive-and-optional is why the schema survives.
