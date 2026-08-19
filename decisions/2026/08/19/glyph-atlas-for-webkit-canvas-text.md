# Cache terminal glyphs in a per-colour atlas, and switch it off when the palette drifts

## Context

The terminal spent 200–350 ms painting one 200×46 frame, which is 3–5 fps under any
real load. Attribution in a purpose-built Swift + WKWebView harness (the same engine
Electrobun renders in) put 779 ms/frame in the canvas and 17.6 ms/frame in the WASM
parser: the emulator and the PTY throughput were both innocent. `installGlyphCellFit`
was also cleared — on ordinary text it measured 350 ms against the vendor's own 344 ms,
indistinguishable, because it forwards everything that is not a box or powerline glyph.

Chromium draws the same frame in 34 ms, so none of this is visible in a Chromium
benchmark and no `agent-browser` measurement can be used to reason about it.

## Investigation

WebKit charges per Canvas2D state change, and `CanvasRenderer.renderCellText` makes two
per cell — a `fillStyle` assignment and a `fillText` that re-shapes the glyph. Isolated
in the same harness: same colour and same glyph 13 ms/frame, varying glyph 182 ms,
varying colour 110 ms, both varying 192 ms with a tail to 2.3 s. Assigning `ctx.font`
with an unchanged string is free; caching the `rgb()` string changes nothing.

Two findings shaped the design, and both contradicted the obvious guess:

1. **Partial coverage is worse than none.** On a stable 256-colour screen, a 32-style
   cap measured 492 ms against 88 ms with no atlas installed at all. Interleaving
   `drawImage` and `fillText` costs more than doing either alone. A cap that cannot take
   the whole screen is not a smaller win, it is a loss.
2. **A drifting palette cannot be cached at any cap.** Three consecutive `term-bench`
   captures shared zero of 1024 colours. At cap 64 that workload did not finish 8 frames
   in six minutes — every frame rasterises hundreds of glyphs that are never reused.

## Decision

`src/mainview/terminal-glyph-atlas.ts` rasterises each glyph once per
(colour, bold, italic) into a paged strip canvas and blits it thereafter. It wraps
`renderCellText` — not `render`, which `terminal-bidi/proxy.ts` already owns — and is
installed after `installGlyphCellFit` so deferred cells fall through into the fitted
wrapper rather than past it.

`MAX_STYLES` is 128 — enough for an ordinary truecolour theme, and half the memory of
256. It is not a throttle: a screen with more colours than the cap overflows it every
window, and the churn detector treats that exactly like a drifting palette and switches
off, so the atlas is never left half-covering a screen.
Guarding that, `createGlyphAtlas` counts style misses per `CHURN_WINDOW_CELLS` window;
the first window after a reset is the warm-up and is not judged, and a later window
still asking for more than `CHURN_NEW_STYLES_LIMIT` unseen colours disables the atlas,
frees every strip (`canvas.width = 0`, not merely dropping the reference) and re-tests
after `CHURN_COOLDOWN_CELLS`.

The churn counter increments **before** the cap check, deliberately: once the cap is
full a drifting palette stops minting styles and would look perfectly settled.

Measured on the shipped configuration, steady-state frame, vendor → atlas:

| screen | vendor | atlas | detector | strips retained |
|---|---|---|---|---|
| 100 colours, stable (fits) | 214 ms | **31 ms** | silent | 27.4 MB |
| 256 colours, stable (overflows) | 517 ms | 534 ms | fires once | 0 MB |
| 256 colours, fresh every frame | 431 ms | 397 ms | fires once | 0 MB |

The middle row is the one the detector earns its place on: at cap 128 without it, that
same screen measured 347 ms — four times worse than not having an atlas at all.

## Risks

- **`renderCellText` decorates cells off state that is not a cell flag.** Besides the
  flags, it underlines the OSC 8 hyperlink in `hoveredHyperlinkId` and every cell inside
  `hoveredLinkRange` — so those defer too (`isHoverDecorated`), blanks included, or a
  hovered link would silently lose its underline. Anyone widening the fast path must
  re-read the vendor's method rather than trust the flag list: the review that found this
  could not reproduce a visible loss (on a file-path hover the underline on screen comes
  from `terminal-link-underlines.ts`'s own overlay canvas, and the vendor drew nothing
  measurable there), so the guard is unit-tested, not screenshot-proven.
- **Nothing caps the total across panes.** Measured with four live 100x23 panes, each
  on its own 100-colour palette: 14.4 MB each, **57.4 MB together**, all four repainting
  in 25-28 ms. A full-screen 100-colour pane on its own measured 27 MB. The arithmetic
  worst case — 128 styles each filling all four pages — would be roughly 75 MB per pane
  and has not been produced by any real screen so far.
- **Two to three expensive frames before the detector fires.** Overflowing screens
  showed 1370 ms and 1073 ms early frames before shutting down.
- **Antialiasing differs from the vendor.** 22.74% of pixels differ on a dense screen;
  the diff image shows stroke bodies identical and only glyph edges changed, because the
  vendor `fillText`s onto the opaque canvas while the strip is transparent. Not visible
  side by side at 6× zoom, but it is not byte-identical and never will be without
  rasterising onto an opaque tile — which would erase overhanging neighbours.
- **The 33–200 colour band is unmeasured.** Both regimes were probed at 256.
- Detector thresholds are tuned to one workload; a screen that legitimately introduces
  33+ new colours per window every window would be switched off wrongly. It degrades to
  vendor speed, so the failure is a lost win rather than a defect.

## Alternatives considered

- **Raise the cap without a detector** — what was originally asked for. Rejected: makes
  the drifting case dramatically worse, which is the exact workload that exposed the
  problem.
- **Keep the cap at 32** — rejected: measurably worse than having no atlas on any
  palette between 33 and ~256 colours.
- **Cap 256** — measured and works (65 ms on a stable 256-colour screen), but costs
  37 MB per pane. 128 halves that and hands the overflow to the detector instead.
- **Rasterise white and tint per cell** — one cache for all colours, no cap at all.
  Rejected for now: needs a second compositing pass per cell and would change the
  antialiasing again. The honest fallback if memory turns out to matter.
- **Patch ghostty-web upstream** — right long-term home, but it is a third-party package
  and this had to land against the version we ship.
