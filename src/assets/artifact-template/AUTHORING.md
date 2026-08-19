# dev3 artifact starter

The layout is fixed; do not list or explore the directory before starting:

- `AUTHORING.md` — read this reference once.
- `index.html` — report copy, sections, fields, and table headings; edit this.
- `report.js` — report data, charts, filters, and interactions; edit this.
- `app.css` — stable responsive visual system and print layout; keep unchanged.
- `app.js` — stable theme, chart, control, and toast bridge; keep unchanged.
- `dev3-icon.png` — bundled brand asset; keep and publish it.

Copy this pristine directory into the task worktree before editing:

```bash
cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report
```

## Edit surface

For most reports, edit only `index.html` and `report.js`.

- `index.html` owns visible copy, sections, form fields, and table headings.
- `report.js` owns all report-specific data and behavior: chart options, table rows, filters, and interactions.
- `app.css` owns the responsive dev3 visual system and print layout.
- `app.js` owns only the reusable theme, chart, and toast shell.

Do not read or edit `app.css` or `app.js` unless the artifact format itself must change. This keeps formatting out of the authoring context and makes normal artifact work a targeted change. Delete irrelevant HTML sections and their matching `report.js` blocks freely; the reusable shell has no dependency on demo data or panels.

## Panels, spacing, and padding

`main.app` spaces its direct children for you, so stacked panels never touch. Add sections as top-level siblings of `.app` and do not hand-add vertical margins between them. Nest a group of panels inside `<div class="stack">` when they belong together; use `.grid`, `.dashboard-grid`, or `.evidence-book` for column layouts.

`.card` already carries its own padding, so a bare `<section class="card">` looks right with plain content inside it. `.section` and `.kpi` set a roomier padding, and `.table-card` intentionally drops it so a table can run edge to edge. Never re-pad a card from report markup.

The container grows with the viewport up to 1840px, so dense tables and dashboards use a wide monitor instead of leaving it empty. Because the panels are wide, put running prose in `<p class="prose">` (or any `.prose` block) to hold a readable line length; short `.muted` and `.section-copy` lines are capped for you. `.kpis` fits as many cards per row as the width allows, so a report may ship three or six KPI cards without a layout override.

## Preview and share

Pass every local dependency explicitly after `--assets`:

```bash
dev3 show-artifact ./dev3-artifact-report/index.html \
  --assets \
  ./dev3-artifact-report/app.css \
  ./dev3-artifact-report/report.js \
  ./dev3-artifact-report/app.js \
  ./dev3-artifact-report/dev3-icon.png \
  --title "Report title"
```

Keep assets beside or below `index.html` and reference them with relative paths. dev3 rewrites local CSS, classic JavaScript, raster references, and CSS `@import` chains for its sandboxed viewer, then includes the original paths in the downloadable ZIP. Pass every imported stylesheet explicitly in `--assets`. The extracted ZIP also opens directly through `file://`. Avoid ES modules and `fetch()` for local files because browsers restrict them for opaque and file origins.

## Network access and external libraries

Artifacts render in a sandboxed opaque-origin iframe with network access open. CDN libraries, fonts, `fetch()`, and WebSockets may reach the user's services or the dev3 dev server, but the target must accept a `null` origin (CORS). Prefer familiar, narrowly scoped libraries from cdnjs when they remove report-specific code, and pin the exact version in the URL. Do not add `integrity` hashes: CDN byte changes must not brick an otherwise compatible artifact. Keep report content and data local; analytics and trackers are not allowed.

The starter already pins ECharts 6.1.0, Choices.js 11.2.3, and noUiSlider 15.8.1 in their URLs. Do not replace their tags or reproduce their behavior in report code. All three degrade safely when offline: charts show a notice, while selects and ranges remain native controls.

## Charts (Apache ECharts from cdnjs)

`index.html` loads Apache ECharts 6.1.0 through a versioned cdnjs tag. Keep that tag intact when the report has charts. Offline, chart hosts show a notice while the rest of the report remains usable.

The stable bridge lives in `app.js` and exposes `window.dev3Artifact.chart()`, `.color()`, `.enhance()`, `.popover()`, `.setControl()`, and `.toast()`. Keep chart options, values, labels, filters, and interactions in `report.js`; use the exposed helpers there without editing the shell. The chart helper applies dev3 tokens, uses the SVG renderer for crisp print/PDF output, adds aria descriptions, re-renders on theme changes, and resizes with its container.

The shell declares the card surface as each chart's `backgroundColor`, because ECharts derives value-label contrast from it — without that, every label renders dark grey inside a white halo, which is illegible on the dark theme. Keep report code out of that decision: do not set `backgroundColor` or hand-color value labels unless the chart sits on a surface other than `--dev3-surface-raised`.

Use `.remount()` when switching a chart view so ECharts redraws its geometry from left to right; use `.update()` when live data should morph in place. The shell keeps ECharts' native timing and disables motion when the user prefers reduced motion.

## Navigation and form controls

Local fragment links are real navigation. Put them in `.section-nav`, give every target an `id` plus `.section-anchor`, and let the shell handle scrolling, focus, `aria-current`, and scrollspy:

```html
<nav class="section-nav"><a href="#results">Results</a></nav>
<section class="section-anchor" id="results"><h2>Results</h2></section>
```

Keep form markup native and opt into the polished CDN controls with one attribute. The original elements remain the form values and the offline fallback; the shell handles keyboard support, labels, output updates, and reset synchronization:

```html
<select id="cohort" data-ui-select><option>Control</option><option>Agent</option></select>
<label for="threshold">Threshold <output for="threshold">80%</output></label>
<input id="threshold" type="range" min="50" max="100" value="80" data-ui-slider data-unit="%" data-pips="3">
```

Use native checkbox, radio, and switch markup from `index.html`; `app.css` supplies the shared skin without report JavaScript.
When report code changes an enhanced select or range, call `dev3Artifact.setControl(element, value)` so the native value, visual control, events, and output stay synchronized.

## Menus, dropdowns, and anything that opens over the report

**Never hand-roll `position: absolute` + `z-index` for a panel that opens.** It is the most common broken artifact: the card, the horizontal scroller, or the sticky table header around it clips the panel, and no z-index can win because the clip happens before stacking. Use the shell's popover — it puts the panel in the browser top layer, where no ancestor can clip it or paint over it:

```html
<div class="popover-anchor">
  <button type="button" data-popover-trigger="branchMenu">refactor/…header-controls <span class="popover-caret" aria-hidden="true">▾</span></button>
  <div class="popover" id="branchMenu">
    <div class="popover-title">Branch</div>
    <button type="button" data-action="copy-path">Copy worktree path</button>
    <button type="button" data-action="checkout">Copy checkout command</button>
    <hr>
    <a href="https://example.com/pr/1412">Open pull request</a>
  </div>
</div>
```

The shell owns opening, `aria-expanded`, `aria-haspopup`, placement against the trigger, flipping above it when the viewport is short, clamping inside the viewport, repositioning on scroll and resize, arrow-key movement, Escape, outside-click dismissal, focus return, and hiding in print. Report code only listens for clicks on its own items. A menu closes on the item that was clicked; add `data-popover-keep-open` to an item that must not close it (a filter panel rather than a menu).

For a panel built after load, register it with `dev3Artifact.popover(panel, triggerElement)` and drive it through the returned `open()`, `close()`, `toggle()`, and `isOpen`. Enhanced selects need nothing: the shell already lifts the Choices list into the top layer, so a filter inside `.table-card` or `.evidence-group` keeps every option reachable.

Style overlays only through `.popover`, `.popover-title`, and plain `button`/`a`/`hr` children. Do not set `position`, `top`, `left`, `inset`, or `z-index` on a popover — the shell writes those. When something genuinely needs its own stacking order, use the `--dev3-z-nav`, `--dev3-z-overlay`, and `--dev3-z-toast` tokens instead of a new number.

## Tables

Every table gets its reading aids from the shell: alternating row tint, a full-row hover highlight, a vertical rule between cells, tabular figures, and a header that stays visible while the rows scroll. Do not re-implement any of it in report code, and do not add per-row background styles.

Mark a sortable heading with `data-sort` plus `tabindex="0"`; the shell maintains `aria-sort` and renders the ascending/descending caret, so report code only has to sort the data. A heading without `data-sort` renders as a plain label with no pointer cursor.

## Dense evidence tables

Keep decision summaries and charts first, then preserve exhaustive source rows in a visible evidence ledger. Large mechanically produced datasets may live in an additional classic JavaScript asset such as `evidence-data.js`; list it in `--assets`, load it before `report.js`, and keep only rendering logic in `report.js`.

Wrap wide tables in `.evidence-table-scroll` and add `.evidence-table` to the table. The shell keeps every column reachable with horizontal scrolling on narrow screens and lays all columns out for print. The first column is pinned while the numbers scroll past it, so put the row's identity there — a day, a cohort, a file — and never a value that only makes sense next to its neighbours. Reuse the semantic source markers `.good`, `.bad`, `.sig`, `.flat`, `.dim`, `.sep`, `.regime`, and `.total`; the shell maps them to dev3 tokens, quiet typographic significance emphasis, column separators, rollout boundaries, and total rows.

## Print and PDF

Choose Auto, Light, or Dark in the report, then print with Cmd/Ctrl+P. The stylesheet preserves the selected theme and chart colors, removes interactive controls, repeats table headers, and avoids splitting cards and rows.

- Keep `print-color-adjust: exact` on `html, body`.
- Keep charts on the SVG renderer.
- Add `print-hidden` to controls that do not belong in static output.
- Add `print-only` to concise context shown only in PDF.
- Closed `details` sections expand for printing and return to their prior state afterwards.
- For dense charts, set `--dev3-print-chart-height` on `<html>` to keep every label visible.
- Check print preview in both Light and Dark after changing layout.

## Contracts to preserve

- Keep `data-dev3-artifact-template="v1"` on `<html>`.
- Keep the dev3 icon and a `DEV3 ARTIFACT · <CATEGORY>` eyebrow.
- Keep `Built with dev3 Artifacts` in the footer.
- Keep the Auto → Light → Dark theme control.
- Keep local navigation functional: a click must scroll, focus the section heading, and expose `aria-current`.
- Use only the bundled `--dev3-*` semantic tokens for color, and the `--dev3-z-*` tokens for stacking.
- Route every panel that opens over the report through `.popover` / `dev3Artifact.popover()`; never hand-roll an absolutely positioned menu.
- Keep the page responsive and keyboard-accessible.
- Keep report content/data local; external libraries and live integrations are allowed.
