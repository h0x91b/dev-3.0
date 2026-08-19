# Artifact overlays live in the browser top layer

## Context

Agent-authored dev3 HTML artifacts repeatedly shipped with unusable menus. The user reported it as a recurring class of bug, not a one-off. The starter gave authors no overlay primitive, so every report invented one: a `position: absolute` panel with a small `z-index`, nested inside whatever card it belonged to.

## Investigation

Measured in headless Chromium on a real artifact (`A B C — имя ветки в git-баре`) and on the starter's own demo:

- A hand-rolled `.menu` (134 px tall) inside a `.bar-frame { overflow-x: auto }` was clipped to 5 px — 96% of it gone. Its `z-index: 5` was irrelevant: the ancestor's overflow clips before stacking is ever consulted.
- The Choices select in `.table-card { overflow: clip }` lost 30 px of its 144 px list whenever the table was short — one option of four unreachable.

Both are the same failure: an overlay cannot escape an ancestor's overflow by tuning numbers. ECharts tooltips were checked too and are fine — ECharts confines them to the chart container itself.

## Decision

`app.js` promotes every panel that opens over the report into the browser **top layer** (`showPopover()` with `popover="manual"`), where no ancestor overflow or stacking context reaches it, and `placeOverlay()` owns its coordinates: placed against the trigger, flipped above it when the viewport is short, clamped inside the viewport, repositioned on scroll and resize.

Two entry points, both in the shell:

- Declarative `.popover` + `data-popover-trigger` markup (`initializePopovers`), with `aria-expanded`, arrow keys, Escape, outside-click dismissal, focus return, and close-on-item-click; `dev3Artifact.popover(panel, trigger)` registers a panel built after load.
- Choices lists are lifted the same way off the library's own `showDropdown`/`hideDropdown` events (`initializeSelects`), so an author gets the fix without asking.

`manual` rather than `auto`: `auto` light-dismiss fires before our own trigger click, reopening what the user just closed, and nested `auto` popovers dismiss each other — Choices must keep control of its list. `app.css` adds a `--dev3-z-nav` / `--dev3-z-overlay` / `--dev3-z-toast` scale so nothing guesses a number again, and `AUTHORING.md` bans hand-rolled absolute panels outright.

## Risks

`showPopover()` needs Chromium 114 / Safari 17 / Firefox 125. Below that the shell falls back to `position: fixed` with the same coordinates — verified by deleting `HTMLElement.prototype.showPopover` before the shell loads: the menu still spills 41 px past `overflow: clip` and stays hit-testable there. The fallback's high `z-index` is confined to the nearest ancestor stacking context, so a pathological wrapper could still cover it; no starter surface does.

Placement is measured, not CSS anchor positioning (Chromium 125+, Safari 26+ only), which keeps one code path across every engine at the cost of a rAF-throttled scroll listener while a panel is open.

## Alternatives considered

- **Strip `overflow` from the clipping ancestors** — impossible: `.evidence-table-scroll` needs `overflow-x: auto` to scroll, and `.table-card` needs `clip` (not `hidden`) or the sticky table header unpins.
- **A bigger `z-index` on overlays** — does not address clipping at all; it is exactly what the broken artifacts already tried.
- **CSS anchor positioning** — less code, but Safari support only landed in 26 and the artifact viewer runs in WKWebView, so a JS fallback would be needed anyway.
- **Reparent panels into `document.body` on open** — works, but it breaks Choices' internal DOM assumptions and moves author markup out from under report event delegation.
