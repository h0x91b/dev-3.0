# 179 — Multi-file artifact bundles

## Context

The artifact starter had grown into one 800-line HTML file, forcing agents to read visual-system code while changing report content. Artifacts already shipped as ZIP files when they contained the bundled icon, so single-file authoring no longer delivered single-file portability in practice.

## Investigation

Extracted bundles can load sibling CSS and classic scripts through `file://`, but the dev3 viewer renders an opaque-origin `srcdoc` without a local base URL. Existing renderer composition already rewrote copied image `src` values to data URLs, so the same boundary can support explicit CSS and classic JavaScript without weakening the iframe sandbox.

## Decision

`dev3 show-artifact --assets` replaces the image-only `--images` contract and accepts allowlisted CSS, classic JS, and raster files below the HTML directory. `saveSharedArtifact` in `src/bun/shared-artifacts.ts` preserves relative paths in storage/ZIP output and uses per-entry DEFLATE whenever it makes the archive smaller; `loadSharedArtifactContent` recursively rewrites local CSS `url()` and `@import` references and labels text data URLs as UTF-8. `composeArtifactDocument` in `src/mainview/utils/artifactDocument.ts` canonicalizes local dot segments and rewrites quoted or unquoted HTML asset attributes for display. The starter keeps ordinary authoring in `index.html` and `report.js`; `app.css` and `app.js` contain stable formatting and helpers backed by version-pinned ECharts, Choices.js, and noUiSlider URLs from cdnjs. Mechanically produced report data may live in another classic script such as `evidence-data.js`, while shared dense-table classes keep every source column available on narrow screens and in print without moving dataset markup into the shell. Before printing, the shell opens closed details, flushes Chromium's compact print layout, and explicitly gives ECharts the resulting container bounds so SVG geometry is not clipped; it restores the interactive state afterwards. The injected agent protocol names the fixed six-file layout and provides exact copy and publish commands so models can start authoring without exploring the shell.

The iframe remains opaque-origin with `sandbox="allow-scripts"`; that sandbox is the security boundary. Its CSP intentionally permits arbitrary origins, `data:`, `blob:`, `file:`, and `views:` resources, inline/eval runtimes, fetch, and WebSockets so normal artifact code does not require policy-specific exceptions.

## Risks

Data URLs increase the renderer payload, circular CSS imports are rejected, and classic scripts cannot use relative module imports or local `fetch()` calls. CDN controls must keep native or textual offline fallbacks, while size/count caps remain authoritative and network requests stay limited to CORS-enabled services. The permissive CSP must never be paired with `allow-same-origin`; artifact scripts are trusted task output but must remain unable to reach the parent DOM or renderer RPC.

## Alternatives considered

Keeping one generated HTML file would preserve the old viewer but require a build step and still expose the full shell to agents. Serving artifact directories from an app URL would preserve arbitrary relative requests, but it adds authenticated routing in both desktop and remote modes and widens the security boundary.
