# 198 — Terminal BiDi is a display-only layer over ghostty-web's renderer

## Context

Issue #1224: Hebrew and Arabic in task terminals render visually reversed and are
unreadable. Panes are painted by `ghostty-web@0.4.0`'s `CanvasRenderer`, whose
`renderLine(cells, row, cols)` uses **the array index as the screen column** — cells
are stored logically, so an RTL run comes out mirrored. `renderLine`,
`renderCellText` and `SelectionManager` are all private; the published API exposes
nothing bidi-related.

Upstream is not close: `ghostty-org/ghostty#1442` has been open since 2024-02 with
two competing unmerged shaper stacks, and `coder/ghostty-web#162` (Ghostty 1.3)
rewrites the whole cell API while adding nothing for bidi. Waiting was not an option;
forking ghostty-web would drag a Zig + WASM build into our release pipeline.

## Investigation

Reading the built vendor bundle turned up the one seam we need: `term.renderer` is
public and **all seven** internal paint paths funnel through
`this.renderer.render(this.wasmTerm, forceAll, viewportY, scrollbackProvider, opacity)`,
whose buffer contract is six small methods. `getLine(y)` returns a fresh copy of the
cells (`slice().map(c => ({...c}))`), so reordering it is safe.

Three ordering facts drive the design, and each has a test:

1. `getCursor()` is the **first** buffer call of a frame, before any `getLine`. A
   "mapping of the last row seen" cache would lag one frame and put the cursor on
   garbage columns while typing.
2. `renderLine` runs synchronously after the `getLine` that produced its cells, so
   `getGraphemeString(row, col)` can be mapped back through that row's ordering.
3. The renderer compares the cursor's x against its own previous value, so a logical
   move that maps to the same visual column must force a repaint of that row.

`bidi-js` only walks UTF-16 code units, so astral RTL (Adlam, Cypriot, Arabic
mathematical) resolves to level 0 — but its character tables *do* know those types.

## Decision

`src/mainview/terminal-bidi/` wraps `renderer.render` and hands the vendor a
visual-order view of its own buffer (`proxy.ts`), built by a pure `reorderRow`
(`reorder.ts`). Behind `GlobalSettings.experimentalTerminalBidi`, off by default,
in Settings → System → Advanced Experience.

- **Base paragraph direction is forced LTR.** Implicit RTL runs reverse in place, so
  prompts, indentation and box drawing never move. The visible cost: a trailing `.`
  after a Hebrew run stays to its right, and a whole-line Hebrew paragraph stays
  left-aligned rather than right-aligned.
- **A cluster is one cell with `width !== 0` plus every consecutive `width === 0` cell
  after it**, and clusters never reverse internally. This is correct for wide-char
  spacers *and* combining marks, so the code never has to tell them apart.
- **The probe string carries one BMP representative per cluster**, substituting a
  fixed same-Bidi_Class stand-in for astral codepoints. String index then equals
  cluster index by construction, which removes the whole astral off-by-one class and
  incidentally makes astral RTL work despite the library's limitation.
- **`codepoint === 0` probes as a space.** U+0000 is Bidi_Class BN and would be
  dropped from reordering, which would corrupt blanks on every row on screen.
- **UAX#9 L4 mirroring** is applied by cloning the one affected cell with a new
  codepoint; without it `א(ב)ג` renders with the brackets facing the wrong way.
- **A fast-path predicate** (`detect.ts`) skips rows with no bidi-relevant codepoint,
  so a screen with no RTL text costs zero engine calls and produces a byte-identical
  paint log. The range table is derived from bidi-js's own tables and guarded by a
  conformance test that sweeps all of Unicode in both directions.

## Risks

- The seam is a public method with private neighbours. A `ghostty-web` upgrade that
  changes `render`'s signature (as #162 does) needs this layer revisited; the
  integration test against the real `CanvasRenderer` is what will catch it.
- **Selection highlight and link hover stay logical.** `SelectionManager` and the
  hover hit-test read `wasmTerm` directly, so a mouse drag over an RTL line
  highlights the wrong cells. Copy is unaffected and correct — the spec wants
  logical order in the clipboard.
- **Arabic is not joined into cursive forms.** Per-cell `fillText` cannot shape.
- **A TUI table row that mixes a box frame with RTL text visibly rearranges.** Verified
  end-to-end in a browser: `│ שלום    │ 42     │` paints as `│ 42     │ שלום    │`,
  because per UAX#9 N1 the neutrals between the Hebrew and the digits inherit RTL, so
  the whole span reverses. That is conformant — VTE does the same without an explicit
  direction override — but it is the strongest argument for keeping the feature opt-in.
- Graphemes in scrollback rows were already looked up against the wrong row upstream
  (the renderer passes the screen row while the cells came from
  `getScrollbackLine`). We pass that through unchanged rather than making it worse.

## Alternatives considered

- **Wait for Ghostty core.** Rejected: open 2.5 years, two competing stacks, no
  milestone, and the blocker for us is in the JS renderer anyway.
- **Fork/vendor ghostty-web** and fix `renderLine` + `SelectionManager` properly
  (`NimbleMarkets/ghostty-web#nm-rtl` as a base). The only way to fix selection, but
  it pulls a Zig toolchain and a Ghostty submodule into our release pipeline for one
  feature. Reconsider if RTL usage grows.
- **Rewrite the ANSI byte stream before `term.write`.** Rejected: escape sequences
  embed column numbers, so reordering text corrupts cursor addressing.
