# Native terminal font rasterization

## Context

The pixel-aligned glyph atlas removed resampling, but Windows Firefox still rendered the bundled font visibly heavier than Windows WezTerm. At 16 CSS pixels and DPR 1.25, matching the browser's own `fillText` was not a sufficient reference: visible ink coverage remained 7–11% higher.

## Investigation

With identical bundled font bytes, foreground, background, and 20 physical pixels, unhinted FreeType reproduced the original WezTerm normal, bold, and synthetic-italic masks exactly. WezTerm [defaults to unhinted rendering at high DPI](https://wezterm.org/config/lua/config/freetype_load_flags.html); its [decoration metrics](https://github.com/wezterm/wezterm/blob/main/wezterm-gui/src/utilsprites.rs) and [custom box glyphs](https://github.com/wezterm/wezterm/blob/main/wezterm-gui/src/customglyph.rs) also explain the remaining line differences. In the running Windows Firefox app, the complete 700×550 sample differs from the unchanged native screenshot by at most one 8-bit RGB level at every pixel; the visible browser crop is byte-identical to its backing canvas.

## Decision

`terminal-font-rasterizer.ts` loads existing CSS font-face assets into pinned FreeType WASM, rasterizes grayscale glyphs without hinting, uses the actual bold face or synthetic emboldening, and applies the native 0.2 italic shear. Font-derived cell dimensions, baselines, and decorations use physical pixels; `terminal-glyph-atlas.ts` still owns accelerated cell copies, while native glyph canvases are bounded by 8 MiB and 8,192 entries, including empty glyphs and colour-map eviction. `terminal-box-drawing.ts` draws all light/heavy straight connections procedurally, preserving the three-quarter-covered single-pixel elbow; the existing fit retains ownership of other block and powerline glyphs. Dark default-foreground dim now preserves half the Mocha foreground's linear-light intensity; the light-theme contrast guard and colour-precedence rules remain unchanged.

## Risks

The dependency adds roughly 0.9 MB of WASM plus font-face memory, and Canvas premultiplication still introduces a maximum one-level compositing difference in the measured sample. System-only fonts, missing glyphs, and complex shaped clusters retain browser rendering, so native pixel parity is not claimed for those paths, arbitrary WezTerm configurations, or other font/DPI combinations. FreeType, wrapper, Brotli, and zlib notices ship in `public/licenses/freetype.txt`; font/rasterizer requests use bundled assets, not an external service.

## Alternatives considered

Global opacity, gamma, or CSS smoothing changes cannot remove different hinting geometry and would also alter solid stems or colours. Disabling the atlas preserves browser-native weight rather than native-terminal weight; changing WezTerm or modifying comparison images would invalidate the reference. Replacing the full renderer with WebGL would remove a one-level compositing difference at disproportionate architectural cost, so the existing Canvas renderer and its shaping fallback remain.
