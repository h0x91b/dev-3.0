# Read the terminal viewport once per frame instead of once per row

## Context

ghostty-web's `getLine(y)` is a compatibility shim over its own fast path, and it
is quadratic by construction:

```js
getLine(A) {
  this.update();
  const B = this.getViewport();                 // the WHOLE screen, parsed
  return B.slice(g, g + this._cols).map((E) => ({ ...E }));
}
```

`getViewport()` is the vendor's own "key performance optimization" — one WASM
call that parses every cell into a reusable pool. `getLine` throws that away by
calling it again for every row it is asked for. `CanvasRenderer.render` asks
per row, so a full repaint of a 200x46 screen parses 9 200 cells 46 times over:
**423 200 cell parses to draw 9 200 cells.**

This is the choppiness behind scrolling, `vim` redraws and anything that
rewrites the whole screen. It is not the keystroke-echo path, which
[terminal-latency-unbatch-writes](terminal-latency-unbatch-writes.md) fixed.

## Investigation

Read before written, because the pool is shared mutable state:

- **`getViewport()` returns `this.cellPool` itself**, not a copy — which is why
  the vendor's `getLine` copies per row. Anything caching it must copy too.
- **`parseCellsIntoPool` is the only writer of that pool**, and only
  `getViewport` calls it. Nothing else can corrupt a cached pool mid-frame.
- **`getScrollbackLine` shares the WASM scratch buffer `viewportBufferPtr`** with
  `getViewport`, so scrollback interleaving looked dangerous. It is not: it
  parses into a fresh array and never touches `cellPool`.
- **`getViewport`, `getLine`, `getDimensions`, `update`, `isRowDirty` are all on
  the same class**, so the cache cannot straddle two objects with different
  `_cols`/`_rows`.
- **`isRowDirty` is a bare WASM call** with no `update()` inside, so the
  renderer's per-row dirty scan was never part of the cost.
- **A frame is synchronous**, so no bytes can arrive between the pool read and
  the last row that reads from it.

### Measured

Real ghostty-web WASM, real `createBidiRenderable`, headless Chromium, 200x46
screen. The A/B is by **capability**: both arms run the shipped code, and the
"vendor" arm is handed a buffer whose `getViewport`/`update` are hidden, which
is exactly the fallback branch. Two independent full runs; 1-minute load read at
both ends of each and never above 6 (4.50 -> 4.26, then 4.31 -> 5.44).

Load-immune, and the real point of the change:

| Per full-repaint frame | vendor | cached |
|---|---|---|
| Full-viewport reads | 46 | **1** |
| `update()` calls | 47 | **2** |
| Cells produced | 9 200 | 9 200, byte-identical |

Timings, 300 iterations per arm, rounds interleaved to cancel drift:

| Stage | vendor AVERAGE | cached AVERAGE | vendor WORST | cached WORST |
|---|---|---|---|---|
| Buffer-read stage, run 1 | 3.97 ms | 0.21 ms | 4.7 ms | 0.3 ms |
| Buffer-read stage, run 2 | 4.03 ms | 0.21 ms | 4.7 ms | 0.3 ms |
| Whole `render()`, run 2 | 8.68 ms | 4.75 ms | 13.6 ms | 8.2 ms |

The saving cross-checks four ways — 3.76, 3.82, 3.81 and 3.90 ms — from two
isolated-stage rounds and the end-to-end `render()` delta. That the end-to-end
delta equals the isolated-stage delta is the check that matters: it says the
saving is the removed work and not a measurement artefact.

**Two limits, stated so nobody misquotes the table.** Chromium's canvas is far
cheaper than WebKit's, so the **absolute** millisecond saving carries over to the
shipped engine but the **percentage** does not. And this pays only on a full
repaint: a lone keystroke dirties about three rows and saves roughly 0.25 ms.

## Decision

`createBidiRenderable` in `src/mainview/terminal-bidi/proxy.ts` reads the
viewport once per frame and slices rows out of it. `beginFrame()` drops the
cache, which is the whole invalidation story — the proxy already had that hook
for the cursor memo.

- **`BidiRenderable` gains optional `getViewport()` and `update()`.** Optional
  because every test fake and the bare-buffer path lack them, and those must keep
  working unchanged.
- **Rows are still copied out of the pool**, exactly as the vendor copies them.
  Handing out pool-backed cells would alias shared mutable state for a saving
  that has not been shown to matter.
- **`update()` is called explicitly** before reading the pool rather than leaning
  on the renderer calling `getCursor()` first. One extra WASM call per frame
  against a dependency on someone else's call order.
- **Three defensive fallbacks**, all to `inner.getLine(y)`: no `getViewport`, no
  `update`, or a pool shorter than `cols * rows`. The last one latches, so a
  vendor whose contract changed degrades to today's behaviour instead of
  rendering garbage.

Guarded by ten tests in `src/mainview/terminal-bidi/__tests__/proxy.test.ts`
against a fake that mimics the shared pool. Three mutations were run against
them: disabling the cache fails 2, aliasing the pool instead of copying fails 6,
and never invalidating on `beginFrame` fails 1.

## Risks

- **The pool is shared mutable state and the cache holds it for a frame.**
  Safe only because `getViewport` is its sole writer — verified in this version
  of the vendor, not a guarantee. The length check is the tripwire, and it only
  catches a size change, not a semantics change.
- **A vendor upgrade could make `getLine` cheap** and leave this as dead
  complexity. It would still be correct, just pointless.
- **Measured in Chromium only.** No WKWebView number exists for this change; the
  Swift harness the atlas work used no longer exists on disk.
- **Nothing here helps scrollback.** With `viewportY > 0` the vendor forces every
  row to repaint (`g > 0 ? !0 : ...`) without ever consulting `isRowDirty`, so
  scrolling through history still repaints in full — each row is merely cheaper
  now. That branch cannot be reached from this proxy.

## Alternatives considered

- **Return pool-backed slices with no copy.** Removes 9 200 object copies per
  full repaint on top of this. Rejected for now: the cells would alias a buffer
  the emulator rewrites, and the copy is not visible next to the 3.8 ms already
  taken off. Worth revisiting only with a measurement that shows it.
- **Cache reordered rows across frames.** Needs per-row invalidation the vendor's
  dirty state does not give us at the granularity required, and would go stale
  in exactly the cases that matter.
- **Patch `getLine` on the vendor object.** Same effect, but it changes behaviour
  for every caller including hover and link detection, which run outside a frame
  and have no `beginFrame()` to invalidate against.
- **Fix it upstream in ghostty-web.** The right long-term home; this had to land
  against the version we ship.
