# Release disposed terminal handlers and canvas backing stores

Superseded on 2026-10-25 by `decisions/2026/10/25/zero-reused-terminal-wasm-pages.md` for dependency delivery only: the same ESM cleanup patch is now baked into a verified local package; its behavior and rationale remain unchanged.

## Context

The installed macOS renderer had a reported 15–17 GiB footprint dominated by graphics resources. Task switches recreate `TerminalView`; removing its canvas nodes alone does not make their backing stores reclaimable while document handlers still retain the terminal.

## Investigation

In ghostty-web 0.4.0, `SelectionManager.attachEventListeners` registers an anonymous document `mousedown` that `dispose` never removes. `Terminal.dispose` sets `isOpen=false` before `cleanupComponents` conditionally removes document `mouseup`, so that removal is skipped too. In an isolated WKWebView running the real `TerminalView`, 21 opens/disposals left 21 callbacks of each kind and 21 main canvases; removing both callbacks allowed reclamation, but native resource release could still wait for GC. At four replay frames/second and 20 remounts, settled footprint fell from 550.6 to 90.9 MiB for Codex and from 420.3 to 89.7 MiB for Claude; graphics DIRTY+SWAPPED fell from 441.7/323.5 to 18.9/17.3 MiB. The full reported 15–17 GiB was not recreated.

## Decision

Pin ghostty-web to 0.4.0 and persist its cleanup changes with Bun's `patchedDependencies` in `patches/ghostty-web@0.4.0.patch`: store/remove the selection `mousedown`, remove terminal `mouseup` regardless of `isOpen`, and zero the renderer canvas during disposal. Docker copies the patches before installing dependencies, and dependency cache keys hash patch contents as well as the lockfile. The patch targets the ESM entry imported by all dev3 callers; the unused UMD distribution is outside this change. Zero `installFilePathUnderlines`' overlay dimensions before removal as well, matching the existing glyph-atlas cleanup policy; `TerminalView`'s opening and redraw sequence needs no change.

## Risks

An upgrade must re-evaluate the dependency patch and its pinned version. Tests exercise the actual dependency's open/dispose cycle, canvas release, word selection, clipboard copy and outside-click clearing; a happy-dom test cannot prove native backing-store reclamation, so measurements use macOS WKWebView. Recorded-output replay does not measure differences in live Codex/Claude redraw frequency, many windows or hours of palette churn.

## Alternatives considered

Zeroing canvas dimensions alone lowers graphics retention but leaves the document handlers and their JS object graphs alive. Runtime interception of `document.addEventListener` or private methods was useful for attribution, but a persisted dependency patch fixes the owning cleanup without adding application wrappers. Reworking glyph caches or preserving renderers across task switches would broaden the change without addressing these confirmed retention roots.
