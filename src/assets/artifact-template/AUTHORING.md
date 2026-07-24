# dev3 artifact starter

This directory is the pristine, task-local dev3 HTML artifact starter. Never edit it in place. Copy the entire directory into the task worktree, then edit only the copy:

```bash
cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report
```

Start from `index.html`. Replace the sample cockpit title, data, chart labels, form fields, and table rows with content for the current task. Keep the useful interaction patterns and remove sections that do not help the report.

## Network access and external libraries

Artifacts render in a sandboxed opaque-origin iframe with **network access open**: you may load extra libraries, styles, and fonts from any CDN, `fetch()` data from the user's own services or the dev3 dev server, and open WebSockets. The sandbox isolates the artifact from the dev3 app itself (no parent page, files, or cookies) — for `fetch()`/WebSocket the target server must accept requests from a `null` origin (CORS). Prefer SRI-pinned (`integrity` + `crossorigin`) CDN script tags so a tampered payload is rejected instead of executed, and keep the report readable offline where practical: content and data inline, libraries as the only network dependency.

## Charts (Apache ECharts from cdnjs)

`index.html` loads the full **Apache ECharts 6.1.0** API through the `<script data-dev3-vendor="echarts@6.1.0">` tag — an SRI-pinned script from `cdnjs.cloudflare.com`. Keep the tag intact including `integrity` and `crossorigin`. Offline, charts degrade to a visible notice while the rest of the report keeps working.

Create charts through the small `dev3Chart(element, optionFactory)` bridge next to the demos (line/area, donut, radar). Pass a container element and a function returning a plain ECharts option; the bridge applies the dev3 token theme, forces the SVG renderer (crisp print/PDF), enables built-in aria descriptions, re-renders on theme switches, and resizes with the container. Mutate the data your factory reads, then call `handle.update()`. Use `tokenColor("--dev3-…", alpha?)` for any explicit colors so both themes and re-theming work.

- Keep the SVG renderer; canvas charts blur or disappear in PDF output.
- Any ECharts chart type is fine (heatmap, sankey, graph, sunburst, gauge, candlestick, …) — prefer it over hand-rolled SVG. The "Chart gallery" card demos heatmap, sankey, sunburst, and gauge through one host; switching series type needs `handle.remount()` (a plain `update()` merge would keep stale axes). Keep the types your report needs, delete the rest of the card.

## Print and PDF

Choose Auto, Light, or Dark in the report, then print normally with Cmd/Ctrl+P. The print stylesheet preserves that selected theme and chart colors, removes interactive controls, compacts the grid, repeats table headers, and avoids splitting cards or rows where possible. Charts re-render at a compact height via the `beforeprint` hook (`html.printing`).

- Keep `print-color-adjust: exact` on `html, body`; never force a light palette inside `@media print`.
- Keep charts on the SVG renderer so they stay crisp in PDF output.
- Add `print-hidden` to controls that do not belong in a static report, and `print-only` to concise context that should appear only in the PDF.
- Check print preview in both Light and Dark after changing the report layout.

Preserve these contracts:

- Keep `data-dev3-artifact-template="v1"` on `<html>`.
- Keep the dev3 icon and a `DEV3 ARTIFACT · <CATEGORY>` eyebrow in the header.
- Keep `Built with dev3 Artifacts` in the footer.
- Keep the Auto → Light → Dark theme control. Auto follows the dev3 host theme and falls back to `prefers-color-scheme` outside dev3.
- Use only the bundled `--dev3-*` semantic tokens for color. Define both dark and light values.
- Keep the page responsive and keyboard-accessible.
- Keep the print stylesheet responsive to the selected theme and suitable for PDF export.
- Keep the pinned ECharts script tag (with `integrity` + `crossorigin`) and the `dev3Chart` bridge intact when the report has charts; remove both only if the report has no charts at all.
- Keep the report's own content and data self-contained; external libraries and live integrations are allowed (see "Network access"), analytics/trackers are not.
- Keep raster images beside or below `index.html` and reference them with relative paths.

Preview the result in dev3 with the icon and any added raster images included:

```bash
dev3 show-artifact ./dev3-artifact-report/index.html \
  --images ./dev3-artifact-report/dev3-icon.png \
  --title "Report title"
```

Pass every other relative raster asset after `--images` too. Artifacts with images download as a ZIP, so the exported report remains portable.
