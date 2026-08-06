# 212 — File-path underlines repaint per frame instead of debounced

## Context

The persistent underline overlay (decision 208) cleared the canvas on every content change and recomputed after a 120 ms trailing debounce. Users reported the underlines blinking two to three times a second while an agent worked, and disappearing entirely during output bursts.

## Investigation

A trailing debounce is reset by each new trigger, so it never fires while triggers keep arriving. Measured on the released build by sampling the overlay canvas at 25 Hz: with a 3 Hz spinner in the pane the overlay was blank in 34 of 100 samples, cycling ~120 ms blank / ~240 ms visible; under sustained output (50 lines/s) it was blank in 54 of 59 samples. Main-thread frame time was unaffected (8.3 ms median both ways), so this was never a CPU-shedding win — the debounce only bought blankness. A full-viewport recompute benchmarks at 0.2 ms for 160×48 with two paths per row, i.e. ~1% of one core even at 60 fps.

## Decision

`src/mainview/terminal-link-underlines.ts`: `contentChanged`/`scheduleRedraw` collapse into one `requestRedraw()` that coalesces every trigger (write batch, `onScroll`, `ResizeObserver`, landed resolutions) into a single `requestAnimationFrame` callback. The eager `clearNow()` on the content path is gone — `redraw()` already clears and strokes in the same synchronous pass, so no frame is ever composited blank. `clearNow()` survives only on the give-up paths inside `redraw()` (no renderer, no metrics), where positions cannot be verified and stale underlines would be worse than none.

## Risks

Between frames the overlay can be up to one frame stale, so during fast scrolling an underline may sit a row off for ~16 ms. Accepted: it is imperceptible, and the alternative is the blanking this replaces. Redraw now runs up to 60 times a second during heavy output instead of rarely; at 0.2 ms per pass that is well inside budget, but a much wider viewport with pathological logical lines would cost proportionally more.

## Alternatives considered

Leading-edge throttle at 10 Hz (rejected: adds a tuning constant and staleness for no measurable saving over per-frame); keep the debounce but shorten it (rejected: starvation is structural, not a tuning problem — any delay is reset by the next write); diff the computed ranges and skip identical repaints (rejected for now: saves only canvas strokes, since the recompute that would be skipped is the same one that produces the comparison key).
