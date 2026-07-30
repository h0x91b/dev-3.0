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

The stable bridge lives in `app.js` and exposes `window.dev3Artifact.chart()`, `.color()`, `.enhance()`, `.setControl()`, and `.toast()`. Keep chart options, values, labels, filters, and interactions in `report.js`; use the exposed helpers there without editing the shell. The chart helper applies dev3 tokens, uses the SVG renderer for crisp print/PDF output, adds aria descriptions, re-renders on theme changes, and resizes with its container.

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

## Dense evidence tables

Keep decision summaries and charts first, then preserve exhaustive source rows in a visible evidence ledger. Large mechanically produced datasets may live in an additional classic JavaScript asset such as `evidence-data.js`; list it in `--assets`, load it before `report.js`, and keep only rendering logic in `report.js`.

Wrap wide tables in `.evidence-table-scroll` and add `.evidence-table` to the table. The shell keeps every column reachable with horizontal scrolling on narrow screens and lays all columns out for print. Reuse the semantic source markers `.good`, `.bad`, `.sig`, `.flat`, `.dim`, `.sep`, `.regime`, and `.total`; the shell maps them to dev3 tokens, quiet typographic significance emphasis, column separators, rollout boundaries, and total rows.

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
- Use only the bundled `--dev3-*` semantic tokens for color.
- Keep the page responsive and keyboard-accessible.
- Keep report content/data local; external libraries and live integrations are allowed.
