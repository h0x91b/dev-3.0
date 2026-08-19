# Terminal writes go straight into ghostty, and the PTY flush loses its flag

## Context

Users reported that the terminal feels slower and scrolls worse than tmux in a
native terminal. It does. Reading the whole path (seq 1575) found three
buffering stages in series on the way back from the shell, adding ≈41 ms on a
60 Hz display where a native terminal adds ≈8 ms:

| Stage | Added | Worst or average | Owner |
|---|---|---|---|
| PTY batch, trailing edge only | 16.0 ms | exact for a lone echo | `pty-server.ts` |
| Waiting for our own rAF write callback | 8.3 ms | average | `TerminalView.tsx` |
| The frame that batch misses (see below) | 16.7 ms | exact | `TerminalView.tsx` |

**That table is the cost BEFORE the change, not the saving.** Reading it as a
saving is what produced three different totals in review, so the arithmetic is
written out here rather than left to the reader:

- **16.0 ms** — a lone keystroke echo is the chunk that *opens* the batch window,
  so it waits the whole of `PTY_BATCH_INTERVAL_MS`, not half of it. Exact, not an
  average. A chunk arriving mid-window waits 8.0 ms on average instead, but that
  chunk is not the interactive echo this is about.
- **8.3 ms** — bytes arrive uniformly inside a 16.7 ms frame, so the mean wait for
  the next rAF boundary is half a frame.
- **16.7 ms** — at that boundary ghostty's own callback has already run and
  painted (it re-registers from inside itself), so our write lands too late for
  that frame and its bytes wait a whole further frame.

After the change the write goes into WASM on arrival, so the only term left is
the wait for ghostty's next paint: **8.3 ms**, the same wait a native terminal
pays. Removed = 41.0 − 8.3 = **32.7 ms (derived)**, being the 16.0 ms window plus
the 16.7 ms missed frame. The 8.3 ms term is *not* removed — it is irreducible on
a 60 Hz display. Every figure here comes from constants and the refresh rate, so
none of it depends on how loaded the machine was.

## Investigation

**The renderer's write batch was justified by a comment that is false for this
emulator.** It claimed batching avoids "per-write layout and render passes" —
true of xterm.js, which this code was ported from. ghostty-web 0.4.0's
`Terminal.write()` only parses into WASM and marks rows dirty
(`ghostty-web.js:2390`); painting happens in its own unconditional
`requestAnimationFrame` loop (`:2639`). So the batch coalesced nothing the
vendor's loop was not already coalescing.

**It also cost a whole frame, by construction.** ghostty registers its
next-frame callback from *inside* its own callback, at the start of the frame's
rAF phase. A socket message landing between frames registers our write callback
after ghostty's, so frame N+1 paints stale state first and our bytes wait for
N+2. Writing on arrival puts them in WASM before ghostty's next render reads it.

**The leading-edge PTY flush was already written and switched off.** It shipped
behind the PostHog flag `remote-terminal-latency` (seq 1470), whose shipped
default is `false`, so every install without a resolved flag — and every install
during the first fetch — paid the full 16 ms window for a lone keystroke echo.
The flag's own decision record
([first-posthog-feature-flag](../08/first-posthog-feature-flag.md)) planned this
removal itself; it happened before the "100 % for one release cycle" soak it
asked for, on the user's call.

**Measured, not assumed, for the renderer half.** Micro-benchmarks on
JavaScriptCore (the WKWebView engine family) ruled out the two string filters on
the write path: 0.22 ms for a 64 KB batch, 0.82 ms for 256 KB. They also sized
what is left — ghostty-web re-parses the whole viewport once per rendered row,
1.58 ms/frame at 200×50 against 0.19 ms with a per-frame cache.

## Decision

1. **`writeToTerminal(data, fromSocket)` replaces `enqueueTermWrite`** in
   `src/mainview/TerminalView.tsx`: no accumulator, no rAF, no cancel on
   cleanup. Callers that need one write still concatenate first — the native
   attach path sends `RIS + replay` as one string, as before.
2. **`enqueuePtyData` in `src/bun/pty-server.ts` always takes the leading
   edge**, with backpressure widening the window when a viewer's socket is
   behind. The `remoteTerminalLatency` entry is gone from `FEATURE_FLAGS` and
   `FEATURE_FLAG_DEFAULTS`; the registry is now empty and the renderer's
   five-minute PostHog poll does not start while it stays that way.
3. **The wheel pacer queues instead of dropping** (`src/mainview/wheel-pacer.ts`):
   a bounded backlog (`WHEEL_BACKLOG_MAX = 96`, ~0.6 s of drain), cleared when
   the finger reverses, drained by a 12 ms timer in `setupMouseTracking`. The
   rate ceiling that decision 175 exists to enforce is untouched — only the
   duration changes.
4. **`src/mainview/terminal-latency.ts` measures the result.** `echo`, `paint`,
   `write`, `frame` and `gap` distributions per pane plus per-second counters
   (fps, writes, PTY bytes/messages, wheel events/lines, missed frames), sampled
   only from idle typing for the round-trip stages, read live via
   `window.__dev3TerminalLatency()` and summarised into the backend log every
   minute. It hangs off `installRenderGuard`'s new `onFrame` callback rather
   than adding a fourth render wrapper.
5. **`TerminalPerfOverlay` puts those numbers on screen**, behind View → Debug →
   Terminal Performance (menu-only, like every other Debug entry; its state
   persists in `localStorage` so a dev-server restart does not cost a trip back
   to the menu). It exists because the first round of fixes was invisible to the
   person feeling the lag — see the alternative below, which this reverses.

## Risks

- **No kill switch for the flush change.** Deleting the flag was the point; a
  regression now needs a release, not a PostHog toggle.
- **Two WS frames per window instead of one** under a continuous stream (~125/s
  against ~62/s per pane), asserted in `pty-output-batching.test.ts`. That is the
  price of never delaying a lone echo, and still far below the raw chunk rate.
- **A bounded backlog still coasts** past where the finger stopped, by up to
  ~0.6 s on a hard flick. Decision 175's intent was "must not coast for
  seconds"; this keeps that, but it is a change in feel, not a pure win.
- **The paint metric attributes a whole frame to the first render after the
  write**, which on a busy pane may be a frame that was going to happen anyway.
  It is an upper bound, not a decomposition.
- **Nothing here was measured end to end on a running app** — the instrumentation
  in point 4 is what makes the next round measurable, and it had no numbers of
  its own to report yet at the time of writing.

## Alternatives considered

- **Flip `FEATURE_FLAG_DEFAULTS` to `true` and keep the flag.** Keeps a kill
  switch, but inverts the flag's meaning and leaves the dead branch AGENTS.md
  forbids.
- **Roll the flag to 100 % in PostHog and change no code.** Leaves every install
  with no key, no network, or a cold cache on the slow path — which is most of
  the reports.
- **Delete the flag plumbing outright.** Its decision record keeps it
  deliberately as the reusable pattern, and `FeatureFlagsModal` reads it. Gating
  the poller off is the part that was pure cost.
- **Keep the rAF batch but register it before ghostty's callback.** No supported
  way to order against a loop the vendor owns privately, and it would buy
  nothing over writing on arrival.
- **Raise the wheel pacer's rate instead of queueing.** Directly reopens the
  1022-byte read-window bug decision 175 fixed.
- **A latency panel in the UI.** Rejected first, then built the same day. The
  reasoning was that a global function and a log line answer the audit question
  without spending a `/ux-principal` pass — true for the audit, false for the
  user, who ran the fixed build, still felt choppy scrolling, and had no way to
  see whether anything had changed. The pass was cheap: the overlay is
  manifest-compliant (a Debug entry, menu-only, zero chrome on the happy path)
  and needed no manifest edit.
