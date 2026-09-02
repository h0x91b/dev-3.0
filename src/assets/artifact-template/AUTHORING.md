# dev3 artifact starter

The layout is fixed; do not list or explore the directory before starting:

- `AUTHORING.md` — this card. Enough for an ordinary report; read it once.
- `REFERENCE.md` — charts, controls, menus, dense tables, print, talking back to the agent. Read a section only when the report needs it.
- `index.html` — the report: copy, sections, fields, table headings. **Edit this.**
- `report.js` — report data, chart options, filters, interactions. **Edit this**; a static report may leave it an empty function.
- `app.css`, `app.js` — the stable visual system and shell. Keep unchanged.
- `dev3-icon.png` — brand asset; keep and publish it.

```bash
cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report      # never edit the pristine source
# … edit index.html and report.js …
dev3 show-artifact ./dev3-artifact-report --title "Report title"   # the directory: every css/js/image in it rides along
```

For most reports, edit only `index.html` and `report.js`. Do not read or edit `app.css` or `app.js` unless the artifact format itself must change — that keeps formatting out of your context. Delete irrelevant HTML sections and their matching `report.js` blocks freely; the shell has no dependency on demo data or panels. Re-running `show-artifact` with the same `--title` publishes a new **version** of the same artifact; never invent `report-v2.html`. Files outside the directory go after `--assets`.

## What the shell already gives you

Write the class — never a `<style>` block, never a hex color, never a px font size.

| You want | Write |
|---|---|
| A panel | `<section class="card section">` with `<h2 class="section-title">` in a `.section-head`; a table panel is `.card.table-card` |
| Panels side by side | `.dashboard-grid` + `span-3` … `span-9` on each child; KPI cards go in `.grid.kpis` (`.card.kpi` → `.kpi-top`, `.kpi-value`, `.trend`) |
| A paragraph | `<p class="prose">` — holds a readable line length inside a wide panel |
| A table that sorts | `<table data-sortable>` and `<th data-sort tabindex="0">` — the shell sorts the rows; `data-sort="3"` on a cell overrides its text. Leave `data-sortable` off when `report.js` renders and sorts the rows itself |
| A dense ledger | `.evidence-table` inside `.evidence-table-scroll`; cell classes `.good` `.bad` `.sig` `.dim` `.wrap`, `tr.total` |
| A status chip | `.pill` + `success` / `warning` / `accent` / `tone`; a progress cell is `.bar-cell` → `.mini-track` → `.mini-fill` |
| A hue | `tone-1` … `tone-6` or `tone-gold` on a card, KPI, pill — everything inside follows |
| A chart | `<div class="chart-host" id="…" role="img">` + `dev3Artifact.chart()` in `report.js` |
| A select, slider, switch | native markup + `data-ui-select` / `data-ui-slider`; `.check`, `.switch`, `.option-group` skin the rest |
| A menu that opens | `.popover-anchor` → `data-popover-trigger` + `.popover` — never `position: absolute` + `z-index` |

## Color: three families, never mixed

- `--dev3-success` / `--dev3-warning` / `--dev3-danger` assert a verdict. Green means "good" to every reader, so never use it to tell two bars apart.
- `--dev3-gold` is emphasis without a verdict; `--dev3-accent` is the interactive color (links, selection, the primary button).
- `--dev3-viz-1` … `--dev3-viz-6` are categorical hues at one lightness — chart series, cohorts. `tone-N` maps to them.
- Every `--dev3-*` color token is a **raw RGB triplet**, so a bare `var()` is an invalid value and the declaration silently drops. If you must write CSS, wrap it: `background: rgb(var(--dev3-surface-raised));`, alpha with a slash: `rgb(var(--dev3-accent) / .18)`; from JavaScript use `dev3Artifact.color("--dev3-accent", .3)`.

## Charts in two lines

```js
const trend = dev3Artifact.chart(document.getElementById("velocityChart"), () => ({ /* ECharts option */ }));
trend.update();     // re-reads the factory and morphs data in place — change what the factory closes over first
trend.remount();    // re-reads the factory and redraws from scratch
```

Pass the **element**, never its id. `update()` and `remount()` take **no arguments**. A `chart()` call that throws kills the whole of `report.js`, so a blank report with one console error is one bad call. The shell colors series from the viz ramp, rescales `fontSize` with the text-size control, re-renders on theme change, and shows a notice when the CDN is unreachable. More: `REFERENCE.md` § Charts.

## Contract

Keep `data-dev3-artifact-template="v1"` on `<html>`, the dev3 icon and a `DEV3 ARTIFACT · <CATEGORY>` eyebrow, the theme and `A− / 100% / A+` controls in `.actions`, `Built with dev3 Artifacts` in the footer. Never define or shadow `window.dev3` — the viewer owns it. A path your JavaScript builds at runtime goes through `dev3Artifact.asset()`.

## When the report needs more — `REFERENCE.md`

| Read the section | When |
|---|---|
| Panels, spacing, and padding | placing panels by hand, print widths |
| Color tokens · Tones | writing any CSS at all |
| Text size | a one-off size, or a px number ECharts reads from something other than `fontSize` |
| Publishing and assets | images under `shots/`, a path built in JavaScript, files outside the report directory |
| Network and libraries | pulling another CDN library, `fetch()` to a dev server |
| Charts | more than one chart, live data, chart types |
| Navigation and form controls | selects, sliders, switches, radio groups, `setControl()` |
| Menus and popovers | a dropdown, an export menu, anything that opens over the report |
| Tables · Dense evidence tables | stacking rules on narrow screens, large generated ledgers |
| Print and PDF | the report will be printed or saved as PDF |
| Asking the user something | a form whose answer goes straight back to the agent |
