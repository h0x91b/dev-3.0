# Native terminal font rasterization

## Context

The pixel-aligned glyph atlas removed resampling, but Windows Firefox still rendered the bundled font visibly heavier than Windows WezTerm. At 16 CSS pixels and DPR 1.25, matching the browser's own `fillText` was not a sufficient reference: visible ink coverage remained 7–11% higher.

## Investigation

With identical bundled font bytes, foreground, background, and 20 physical pixels, unhinted FreeType reproduced the original WezTerm normal, bold, and synthetic-italic masks exactly. WezTerm [defaults to unhinted rendering at high DPI](https://wezterm.org/config/lua/config/freetype_load_flags.html); its [decoration metrics](https://github.com/wezterm/wezterm/blob/main/wezterm-gui/src/utilsprites.rs) and [custom box glyphs](https://github.com/wezterm/wezterm/blob/main/wezterm-gui/src/customglyph.rs) also explain the remaining line differences. In the Linux-hosted app viewed through Windows Firefox, the complete 700×550 sample differs from the unchanged native screenshot by at most one 8-bit RGB level at every pixel; the visible browser crop is byte-identical to its backing canvas.

The dependency is the immutable npm release `@zkl2333/freetype-wasm@2.14.3`, pinned with package integrity in `bun.lock`, not the upstream repository's mutable version tag; its bundled `freetype.wasm` SHA-256 is `5bf5632afda02e9579a95151a17b4740443d65078d8946f2a70e5e8aaad4af39`.

## Decision

`terminal-font-rasterizer.ts` loads existing CSS font-face assets into pinned FreeType WASM, rasterizes grayscale glyphs without hinting, uses the actual bold face or synthetic emboldening, and applies the native 0.2 italic shear; glyph errors fall back to browser text, while a failed library load can be retried by the next preparation request. Font-derived cell dimensions, baselines, and decorations use physical pixels; `terminal-glyph-atlas.ts` still owns accelerated cell copies, while native glyph canvases are bounded by 8 MiB and 8,192 entries and released when font loading invalidates the style cache. `terminal-box-drawing.ts` draws light/heavy straight connections, rounded corners, dashed lines and single/double-line junctions procedurally for every font, including system fonts; diagonal, block and powerline glyphs retain the existing font-and-cell-fit path. Dark default-foreground dim preserves half the Mocha foreground's linear-light intensity; the light-theme contrast guard and colour-precedence rules remain unchanged.

## Risks

System-font text, missing glyphs, and complex shaped clusters retain browser rendering, but supported box strokes are procedural regardless of font; native pixel parity is not claimed for fallback text, arbitrary WezTerm configurations, or other font/DPI combinations. Bundled glyphs also bypass WebKit on macOS despite retaining the earlier DOM-attached atlas smoothing fix, so native WKWebView appearance and performance require separate validation. The single-maintainer package adds roughly 0.9 MB of WASM plus font memory: pinning and recording its checksum establish artifact identity, not a security audit, and explicit maintainer sign-off on this dependency is still required before merge. FreeType, wrapper, Brotli and zlib notices ship in `public/licenses/freetype.txt`, all font/rasterizer requests use bundled assets rather than an external service, and Canvas premultiplication accounts for the measured maximum one-level compositing difference.

## Alternatives considered

Global opacity, gamma, or CSS smoothing changes cannot remove different hinting geometry and would also alter solid stems or colours. Disabling the atlas preserves browser-native weight rather than native-terminal weight; changing WezTerm or modifying comparison images would invalidate the reference. Replacing the full renderer with WebGL would remove a one-level compositing difference at disproportionate architectural cost, so the existing Canvas renderer and its shaping fallback remain.

Vendoring the same prebuilt WASM would relocate the binary without removing trust in its producer; an independently audited source build would be a different dependency decision, not evidence supplied by the current pin or test results.

## Verification

Regressions cover glyph-error fallback, shifted decoration coordinates, retry recovery, cache invalidation and physical-pixel box joins. The [live terminal screenshot](native-terminal-font-box-joins.png) shows rounded, dashed, double and mixed frames in Firefox at 16 CSS pixels and DPR 1.25 against the Linux-hosted app; system-font Consolas was also checked through the browser fallback.
