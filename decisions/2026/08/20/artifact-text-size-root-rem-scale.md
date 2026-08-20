# Artifact text size is one root rem scale, not a zoom

## Context

An artifact is read inside dev3's sandboxed iframe, where the browser's own zoom belongs to the whole app, not to the report. Readers wanted the report's text bigger (or denser) on its own, so the starter needed a text-size control that every part of a report obeys — including ECharts, Choices, and noUiSlider, which dev3 does not own.

## Investigation

Three approaches were compared. CSS `zoom` on `.app` scales everything for free but leaves top-layer popovers, the toast, and fixed overlay placement outside the scaled subtree, and it fights the shell's own `getBoundingClientRect()` placement maths. A per-component size class multiplies the surface that has to remember the setting. A single root scale plus relative units touches every rule once and then needs no further maintenance.

Vendor CSS decided the third option was viable: Choices 11 sizes its chips, search field, and select hint from `--choices-font-size-lg/md/sm`, so handing it rem values scales parts dev3 never styles. noUiSlider hardcodes only `.noUi-value-sub`, which the shell overrides anyway.

## Decision

`app.css` sets `html { font-size: calc(100% * var(--dev3-font-scale)) }` and every font size in the sheet is a rem — `em` where a glyph belongs to its own label (checkbox, radio, switch, slider handle, status dot). `app.js` owns eight steps from 0.8 to 1.5 (`FONT_SCALE_STEPS`), writes `--dev3-font-scale-user` on `<html>`, and persists to `localStorage` best-effort — the sandbox's opaque origin makes that throw, so the preference simply does not survive there.

ECharts sizes are raw numbers, so `scaleOptionFonts()` in `app.js` rewrites every `fontSize` in an option tree before `setOption`, copying plain branches and passing functions and primitive data arrays through by reference. A scale change re-registers the chart theme and remounts, re-measures the sticky table-header offset, and repositions open overlays.

Print follows the scale rather than resetting to 100%: the print rules are the same rem values, and `--dev3-print-chart-height` defaults to `9.6875rem` so enlarged chart labels get proportionally taller charts instead of colliding.

## Risks

A report that hardcodes a px font size in `index.html` or `report.js` stays at 100% while the page grows; `AUTHORING.md` forbids it and two tests assert `app.css` itself contains no px font size (`artifact-template.test.ts`, `artifactTemplateRuntime.test.ts`). `scaleOptionFonts` clones plain objects on every render, so a pathological option tree of nested objects (not data arrays, which are passed through) pays a small allocation cost.

## Alternatives considered

CSS `zoom` (breaks top-layer overlays and the shell's placement maths); scaling only `body` font-size (rem-based rules elsewhere would ignore it); resetting the scale for print (leaves half the print sheet scaled and half not, since print declares its own sizes).
