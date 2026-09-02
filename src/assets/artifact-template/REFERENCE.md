# dev3 artifact starter — reference

`AUTHORING.md` is the card; this file is the depth behind it. Read the section the report needs, not the file.

## Panels, spacing, and padding

`main.app` spaces its direct children for you, so stacked panels never touch. Add sections as top-level siblings of `.app` and do not hand-add vertical margins between them. Nest a group of panels inside `<div class="stack">` when they belong together; use `.grid`, `.dashboard-grid`, or `.evidence-book` for column layouts.

`.card` already carries its own padding, so a bare `<section class="card">` looks right with plain content inside it. `.section` and `.kpi` set a roomier padding, and `.table-card` intentionally drops it so a table can run edge to edge. Never re-pad a card from report markup.

`.dashboard-grid` is a 12-column grid. A panel inside it takes the whole row unless you give it a width, so a card you drop in never collapses into a sliver. To put panels side by side add `span-3` … `span-9` (`<article class="card section span-6">`); the widths apply above 900px and every panel goes full width below that and in print.

The container grows with the viewport up to 1840px, so dense tables and dashboards use a wide monitor instead of leaving it empty. Because the panels are wide, put running prose in `<p class="prose">` (or any `.prose` block) to hold a readable line length; short `.muted` and `.section-copy` lines are capped for you. `.kpis` fits as many cards per row as the width allows, so a report may ship three or six KPI cards without a layout override.

## Color tokens

Every `--dev3-*` color token holds a **raw RGB triplet** (`14 18 30`), not a color. `background: var(--dev3-surface-raised)` is therefore an invalid value: the declaration is dropped and the element renders with no background, silently. Always wrap the token:

```css
background: rgb(var(--dev3-surface-raised));
color: rgb(var(--dev3-text-secondary));
border: 1px solid rgb(var(--dev3-border));
background: rgb(var(--dev3-accent) / .18);          /* the slash sets alpha */
box-shadow: 0 8px 24px rgb(var(--dev3-shadow) / .35);
```

`--dev3-shadow` is a triplet like the rest — the shadow geometry is yours, the token only supplies its color. The `--dev3-z-*` stacking tokens are plain numbers and are used bare (`z-index: var(--dev3-z-overlay)`).

From report JavaScript ask the shell instead of reading the variable — it returns a finished color string:

```js
const line = dev3Artifact.color("--dev3-accent");        // "rgb(68, 150, 255)"
const fill = dev3Artifact.color("--dev3-accent", .3);    // "rgba(68, 150, 255, 0.3)"
```

The tokens: `--dev3-surface-base`, `--dev3-surface-raised`, `--dev3-surface-elevated`, `--dev3-text-primary`, `--dev3-text-secondary`, `--dev3-text-muted`, `--dev3-border`, `--dev3-accent`, `--dev3-on-accent`, `--dev3-gold`, `--dev3-gold-ink`, `--dev3-on-gold`, `--dev3-success`, `--dev3-warning`, `--dev3-danger`, `--dev3-shadow`, and `--dev3-viz-1` … `--dev3-viz-6`.

### One color, one meaning

Three families, and mixing them is the mistake this section exists to prevent.

**Semantic — states only.** `--dev3-success`, `--dev3-warning`, `--dev3-danger` assert a verdict, so they belong to a passing check, a caution, a failure. Never reach for green because a bar needs to differ from the bar beside it: a reader takes green as "good" whatever you meant. `--dev3-accent` is the interactive color — selection, focus, links, the primary button — and stays out of decoration.

**Brand — `--dev3-gold`.** Emphasis without a verdict: the artifact eyebrow chip, panel heading markers, a significance mark, a total row, a target line. It is not a warning; `--dev3-warning` still owns that. Gold ships as three tokens because a gold that passes contrast as *text* on a white page is brown. Use `--dev3-gold` for fills, rules, and markers; `--dev3-gold-ink` only when gold is the text color; `--dev3-on-gold` for text sitting **on** a gold fill.

**Categorical — `--dev3-viz-1` … `--dev3-viz-6`.** Six hues at one lightness for things that merely differ from each other: chart series, cohorts, categories. Equal lightness is the point — no series looks more important than its neighbour. They are also the chart theme's default series order, so a plain chart is already correctly colored and needs no `color` array at all.

### Tones — a hue per panel, without writing a color

Add `tone-1` … `tone-6` (or `tone-gold`) to any element and everything under it that reads `--dev3-tone` picks up that hue: the KPI card's top rail, its section heading marker, `.pill.tone`, `.mini-fill`, and `.evidence-marker`. Drop the class and each falls back to its default — accent for the rail, gold for the heading marker.

```html
<article class="card kpi tone-5">…</article>
<article class="card section tone-2"><h2 class="section-title">Cost</h2>…</article>
<span class="pill tone">Research</span>
```

This is the sanctioned way to color a report. It keeps every hue inside the theme, so light mode, dark mode, and print all stay correct — a hand-written hex does none of that.

## Text size

The topbar carries an `A− / 100% / A+` group beside the theme button. It steps the whole report between 80% and 150% in ten-point stops, the percentage doubles as the reset button, and the choice is remembered per browser (silently skipped in the sandboxed viewer, whose opaque origin has no storage). Keep the control in `.actions`.

Everything in `app.css` is sized in `rem`, or in `em` for a glyph that belongs to its own label, so one root scale carries text, chart heights, checkboxes, switches, sliders, and the Choices dropdowns with it. Print follows the same scale — an enlarged report prints enlarged.

Two rules for report code:

- Never write a px font size in `index.html` or `report.js`. Use the shell's classes, or `rem` if a one-off is unavoidable.
- Chart options are exempt: the shell rescales every `fontSize` number in an option tree before ECharts sees it, so `fontSize: 12` in `report.js` stays correct at every scale. Use `dev3Artifact.scaleFont(px)` for a px number ECharts does not read from `fontSize` (an `itemHeight`, a `grid.left` sized for labels), and `dev3Artifact.fontScale()` for the raw multiplier.

## Publishing and assets

`dev3 show-artifact ./dev3-artifact-report --title "Report title"` publishes the directory: `index.html` plus every CSS, classic JavaScript, and raster file under it. Pass the HTML file instead when the report is a single file, and list files that live elsewhere after `--assets`:

```bash
dev3 show-artifact ./dev3-artifact-report --title "Report title"
dev3 show-artifact ./dev3-artifact-report/index.html --assets ./dev3-artifact-report/app.css ./dev3-artifact-report/app.js ./dev3-artifact-report/report.js ./dev3-artifact-report/dev3-icon.png ../shared/chart.png --title "Report title"
```

Keep assets beside or below `index.html` and reference them with relative paths. dev3 rewrites local CSS, classic JavaScript, raster references, and CSS `@import` chains for its sandboxed viewer, then includes the original paths in the downloadable ZIP.

**A path your report code builds at runtime needs `dev3Artifact.asset()`.** The rewriting above scans the stored HTML text, so an `src` that only exists after `report.js` runs is never in it — and the viewer's iframe has an opaque origin where a relative path resolves to nothing. Resolve it through the shell instead:

```js
const src = dev3Artifact.asset("shots/run-42.png");        // data URL in the viewer, the path itself over file://
host.innerHTML = `<img src="${src}" alt="Run 42 timeline">`;
element.style.backgroundImage = `url("${dev3Artifact.asset("shots/grid.png")}")`;
```

It is safe everywhere: with no viewer map (file://, the extracted ZIP) it returns the path unchanged, and it leaves absolute URLs, data URLs, and CDN links alone. The viewer also heals a bare relative `src` on `img` and `source` elements added after load, so an older report still renders — but write `asset()` in new code, because that fallback covers nothing else (CSS you build in JS, `fetch()`, canvas, a download link). Pass every imported stylesheet explicitly in `--assets` when it is not under the report directory. The extracted ZIP also opens directly through `file://`. Avoid ES modules and `fetch()` for local files because browsers restrict them for opaque and file origins.

## Network access and external libraries

Artifacts render in a sandboxed opaque-origin iframe with network access open. CDN libraries, fonts, `fetch()`, and WebSockets may reach the user's services or the dev3 dev server, but the target must accept a `null` origin (CORS). Prefer familiar, narrowly scoped libraries from cdnjs when they remove report-specific code, and pin the exact version in the URL. Do not add `integrity` hashes: CDN byte changes must not brick an otherwise compatible artifact. Keep report content and data local; analytics and trackers are not allowed.

The starter already pins Apache ECharts 6.1.0, Choices.js 11.2.3, and noUiSlider 15.8.1 in their URLs. Do not replace their tags or reproduce their behavior in report code. All three degrade safely when offline: charts show a notice, while selects and ranges remain native controls.

## Charts (Apache ECharts from cdnjs)

The starter loads Apache ECharts 6.1.0 through a versioned cdnjs tag. Keep that tag intact while the report has charts:

```html
<script data-dev3-vendor="echarts@6.1.0" src="https://cdnjs.cloudflare.com/ajax/libs/echarts/6.1.0/echarts.min.js" referrerpolicy="no-referrer"></script>
```

The stable bridge lives in `app.js` and exposes `window.dev3Artifact.asset()`, `.chart()`, `.color()`, `.enhance()`, `.fontScale()`, `.popover()`, `.scaleFont()`, `.setControl()`, and `.toast()`. Keep chart options, values, labels, filters, and interactions in `report.js`; use the exposed helpers there without editing the shell. The chart helper applies dev3 tokens, uses the SVG renderer for crisp print/PDF output, adds aria descriptions, re-renders on theme changes, and resizes with its container.

The shell declares the card surface as each chart's `backgroundColor`, because ECharts derives value-label contrast from it — without that, every label renders dark grey inside a white halo, which is illegible on the dark theme. Keep report code out of that decision: do not set `backgroundColor` or hand-color value labels unless the chart sits on a surface other than `--dev3-surface-raised`.

`chart()` takes an **element** and an **option factory** — a function returning the option object, so the shell can re-read it on a theme change, a text-size change, or a data change:

```js
let period = 30;
const velocity = dev3Artifact.chart(document.getElementById("velocityChart"), () => ({
  xAxis: { type: "category", data: labels[period] },
  yAxis: { type: "value" },
  series: [{ type: "line", data: series[period], itemStyle: { color: dev3Artifact.color("--dev3-accent") } }],
}));

period = 90;
velocity.update();    // () — re-reads the factory, morphs the data in place
velocity.remount();   // () — re-reads the factory, redraws geometry from scratch
velocity.resize();    // () — the shell already calls this on container resize
```

Three rules the signature implies, each of which used to fail quietly:

- **Pass the element, never its id.** `chart("velocityChart", …)` reaches ECharts as a string and throws from minified library code; the shell now throws first with the fix in the message.
- **`update()` and `remount()` take no arguments.** They re-read your factory, so change the data the factory closes over and then call them. Passing a new option object used to be ignored and read like a caching bug; it now throws.
- **A throwing `chart()` call kills the whole report**, because `report.js` is one IIFE — every later chart, table, and listener in the file dies with it. A blank report with one error is usually one bad `chart()` call, not four broken panels.

Use `.remount()` when switching a chart view so ECharts redraws its geometry from left to right; use `.update()` when live data should morph in place. The shell keeps ECharts' native timing and disables motion when the user prefers reduced motion. A few option shapes that render well on the shell, all colored from the viz ramp unless a series carries a verdict:

- **Line with area:** `series: [{ type: "line", smooth: true, areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: dev3Artifact.color("--dev3-viz-1", .3) }, { offset: 1, color: dev3Artifact.color("--dev3-viz-1", 0) }] } } }]`.
- **Donut:** `series: [{ type: "pie", radius: ["52%", "76%"], itemStyle: { borderColor: dev3Artifact.color("--dev3-surface-raised"), borderWidth: 3, borderRadius: 7 }, label: { show: false } }]`, legend at the bottom; only a genuinely bad slice takes `--dev3-danger`.
- **Heatmap:** `visualMap.inRange.color: [dev3Artifact.color("--dev3-viz-1", .08), dev3Artifact.color("--dev3-viz-1"), dev3Artifact.color("--dev3-viz-2")]`.
- **Gauge:** hide `axisTick`, `splitLine`, `axisLabel`, `pointer`, `anchor`; `progress: { show: true, roundCap: true }`; `axisLine.lineStyle.color: [[1, dev3Artifact.color("--dev3-border", .55)]]`.
- **Sankey, sunburst, radar** work unchanged; give node `itemStyle.color` through `dev3Artifact.color(token, alpha)`.

## Navigation and form controls

Local fragment links are real navigation. Put them in `.section-nav`, give every target an `id` plus `.section-anchor`, and let the shell handle scrolling, focus, `aria-current`, and scrollspy:

```html
<nav class="section-nav"><a href="#results">Results</a></nav>
<section class="section-anchor" id="results"><h2>Results</h2></section>
```

Form controls are enhanced by two pinned CDN libraries the starter already loads; these are the tags, should a report that removed them need them back — the stylesheets in `<head>`, the scripts before `app.js`:

```html
<link data-dev3-vendor="choices.js@11.2.3" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.css" referrerpolicy="no-referrer">
<link data-dev3-vendor="nouislider@15.8.1" rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.css" referrerpolicy="no-referrer">
<script data-dev3-vendor="choices.js@11.2.3" src="https://cdnjs.cloudflare.com/ajax/libs/choices.js/11.2.3/choices.min.js" referrerpolicy="no-referrer"></script>
<script data-dev3-vendor="nouislider@15.8.1" src="https://cdnjs.cloudflare.com/ajax/libs/noUiSlider/15.8.1/nouislider.min.js" referrerpolicy="no-referrer"></script>
```

Keep form markup native and opt into the polished controls with one attribute. The original elements remain the form values and the offline fallback; the shell handles keyboard support, labels, output updates, and reset synchronization:

```html
<form class="controls">
  <div class="field"><label for="cohort">Cohort</label><select id="cohort" data-ui-select><option>Control</option><option>Agent</option></select></div>
  <div class="field full"><label for="threshold">Threshold <output for="threshold">80%</output></label><input id="threshold" type="range" min="50" max="100" value="80" data-ui-slider data-unit="%" data-pips="3"></div>
  <label class="check field full"><input type="checkbox" checked> Include experimental presets</label>
  <fieldset class="option-group field full"><legend>Review mode</legend><div class="choice-grid"><label class="check"><input type="radio" name="mode" checked> Automatic</label><label class="check"><input type="radio" name="mode"> Manual</label></div></fieldset>
  <label class="switch field full"><input type="checkbox" checked><span aria-hidden="true"></span> Auto-refresh</label>
  <div class="form-actions field full"><button type="reset">Reset</button><button class="primary" type="submit">Apply</button></div>
</form>
```

`.controls` is a two-column grid; `.field.full` spans both. `.check`, `.switch`, and `.option-group` skin native checkbox, radio, and switch markup without report JavaScript. A `.segmented` group of buttons (`<button class="active">`) toggles a view; report code flips `.active` and calls `remount()` on the chart. When report code changes an enhanced select or range, call `dev3Artifact.setControl(element, value)` so the native value, visual control, events, and output stay synchronized. `dev3Artifact.toast("Saved")` shows the transient message in `#toast`.

## Menus, dropdowns, and anything that opens over the report

**Never hand-roll `position: absolute` + `z-index` for a panel that opens.** It is the most common broken artifact: the card, the horizontal scroller, or the sticky table header around it clips the panel, and no z-index can win because the clip happens before stacking. Use the shell's popover — it puts the panel in the browser top layer, where no ancestor can clip it or paint over it:

```html
<div class="popover-anchor">
  <button type="button" data-popover-trigger="runsMenu">Export <span class="popover-caret" aria-hidden="true">▾</span></button>
  <div class="popover" id="runsMenu">
    <div class="popover-title">Export runs</div>
    <button type="button" data-action="copy-csv">Copy as CSV</button>
    <button type="button" data-action="copy-md">Copy as Markdown</button>
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

Mark a sortable heading with `data-sort` plus `tabindex="0"`; the shell maintains `aria-sort` and renders the ascending/descending caret. On a `<table data-sortable>` the shell also reorders the rows itself, comparing each cell's `data-sort` value or, without one, its text (numeric-aware). Leave `data-sortable` off when report code renders the rows from data and sorts them itself. A heading without `data-sort` renders as a plain label with no pointer cursor. A search box and a filter select belong in `.table-tools` inside the `.section-head.table-head`; report code filters the rows.

**No table scrolls sideways, and you write nothing to get that.** Below 768px of the table's own container each row stops being a row of columns and becomes a stack of labelled lines; the shell copies every `thead` heading onto the cells beneath it, so a plain `<table>` with a real `<thead>` is the whole requirement. Never add a horizontal scroller, a `width: max-content`, or a `white-space: nowrap` around a table — that is the pattern this replaces. Three consequences worth knowing: a table needs a `<thead>` or its stacked cells have no labels; the header row is hidden while stacked, so a report that must stay sortable on a phone puts a sort `<select>` in `.table-tools`; and the box measured is the table's **direct parent**, so a wrapper you add around it is what decides — give it no width of its own. Print is unaffected — paper always gets real columns and a repeating header.

### Dense evidence tables

Keep decision summaries and charts first, then preserve exhaustive source rows in a visible evidence ledger. Large mechanically produced datasets may live in an additional classic JavaScript asset such as `evidence-data.js`; keep it under the report directory (or list it in `--assets`), load it before `report.js`, and keep only rendering logic in `report.js`.

Wrap wide tables in `.evidence-table-scroll` and add `.evidence-table` to the table. The wrapper keeps its name but no longer scrolls: it is what makes the table measure its own box, so a ledger inside a half-width panel stacks while the page is still wide. Put the row's identity in the first column — a day, a cohort, a file — and never a value that only makes sense next to its neighbours; it is the line a reader looks for first in both the tabular and the stacked form. Mark a prose cell `.wrap` and it takes the full width instead of one column when stacked. Reuse the semantic source markers `.good`, `.bad`, `.sig`, `.flat`, `.dim`, `.sep`, `.regime`, and `.total`; the shell maps them to dev3 tokens, quiet typographic significance emphasis, column separators, rollout boundaries, and total rows.

## Print and PDF

Choose Auto, Light, or Dark in the report, then print with Cmd/Ctrl+P. The stylesheet preserves the selected theme and chart colors, removes interactive controls, repeats table headers, and avoids splitting cards and rows.

- Keep `print-color-adjust: exact` on `html, body`.
- Keep charts on the SVG renderer.
- Add `print-hidden` to controls that do not belong in static output.
- Add `print-only` to concise context shown only in PDF.
- Closed `details` sections expand for printing and return to their prior state afterwards.
- For dense charts, set `--dev3-print-chart-height` on `<html>` to keep every label visible.
- Check print preview in both Light and Dark after changing layout.

## Asking the user something (`window.dev3.sendToAgent`)

A report can carry a form and send the answer straight to the agent that published it, instead of making the user retype it into the terminal. The channel is one-way: the agent answers by republishing the artifact as a new version.

**`window.dev3` comes from the viewer, not from this template.** It is injected into the document before `app.js` runs, so it exists in every artifact — including ones not built from this starter. Never define, wrap, or shadow `window.dev3` in report or shell code; the bridge is gone the moment you do. It is a separate global from `window.dev3Artifact` for exactly that reason: the shell freezes its own object, and freezing would drop the bridge.

```js
if (window.dev3?.canSendToAgent) {
  sendButton.addEventListener("click", async () => {
    try {
      await window.dev3.sendToAgent(`Picked option ${choice}. Skip: ${skipped.join(", ")}`);
      dev3Artifact.toast("Sent to the agent");
    } catch (err) {
      dev3Artifact.toast(err.reason === "failed" ? "The agent is not running" : "Could not send that");
    }
  });
} else {
  form.remove();   // no channel here — do not render a control that cannot work
}
```

- **`canSendToAgent`** — read it before rendering the form, and read it **again on every use**: it is a live getter the viewer can flip while the document is open, not a value to cache at startup. It is false in a copy opened in its own browser tab, in a downloaded file, on an older version of the artifact, and when the owning task has finished. It is true again on an older version the user is part-way through answering. It does **not** promise an agent is running right now — that is only knowable at send time, and it arrives as a rejection.
- **`sendToAgent(text)`** — returns a promise; the rejected `Error` carries a machine-readable `reason`: `unavailable`, `empty`, `busy`, `no-gesture`, `timeout`, `failed`.
- **Call it from a real click or key press.** A call that no trusted input precedes is refused (`no-gesture`) — that guard is why an unattended script in a report cannot drive the agent.
- **One send at a time.** A second call while one is in flight rejects with `busy`, so a double click cannot send twice.
- The body is a plain string and travels verbatim. Want structure, format it yourself. There is no length cap — an oversized body is spilled to a file the same way an oversized `dev3 message` is.

### Unsent input survives a republish — you get this for free

The agent answers by publishing a new version, and that replaces the document the user is looking at. Anything they had typed and not sent would go with it, so the viewer keeps it: every `<input>`, `<textarea>` and `<select>` whose value no longer matches its default is reported out of the frame automatically and held there. When the version it belongs to is on screen again the values are put back and `input` / `change` fire on each restored control, so report code that mirrors its own state hears about it. **Write nothing for this** — no save button, no storage call.

Storage inside an artifact is not an alternative: the viewer sandboxes the document without `allow-same-origin`, so `sessionStorage`, `localStorage` and `document.cookie` all throw `SecurityError`. That is why the draft lives outside the frame.

Two things it deliberately does not carry: a `type="password"` or `type="file"` field, and state your report holds in JavaScript rather than in a control. For the second, hand it over yourself and listen for it coming back:

```js
dev3.saveDraft({ picked: choice, skipped });          // any JSON-serialisable value

addEventListener("dev3:draft-restore", (event) => {
  applyMyState(event.detail);                          // exactly what saveDraft() was given
});
```

## Contracts to preserve

- Keep `data-dev3-artifact-template="v1"` on `<html>`.
- Keep the dev3 icon and a `DEV3 ARTIFACT · <CATEGORY>` eyebrow.
- Keep `Built with dev3 Artifacts` in the footer.
- Keep the Auto → Light → Dark theme control and the `A− / 100% / A+` text-size control.
- Keep local navigation functional: a click must scroll, focus the section heading, and expose `aria-current`.
- Use only the bundled `--dev3-*` tokens for color, always as `rgb(var(--token))` or `rgb(var(--token) / a)`, and the `--dev3-z-*` tokens for stacking. Reach for a `tone-*` class before a token, and never for a status color to make two things merely look different.
- Resolve any asset path built by report code through `dev3Artifact.asset()`.
- Route every panel that opens over the report through `.popover` / `dev3Artifact.popover()`; never hand-roll an absolutely positioned menu.
- Keep the page responsive and keyboard-accessible.
- Keep report content/data local; external libraries and live integrations are allowed.
- Never define or shadow `window.dev3` — the viewer owns it (see the section above).
