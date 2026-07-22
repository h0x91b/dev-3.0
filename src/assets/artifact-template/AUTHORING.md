# dev3 artifact starter

This directory is the pristine, task-local dev3 HTML artifact starter. Never edit it in place. Copy the entire directory into the task worktree, then edit only the copy:

```bash
cp -R "$DEV3_ARTIFACT_TEMPLATE_DIR" ./dev3-artifact-report
```

Start from `index.html`. Replace the sample cockpit title, data, chart labels, form fields, and table rows with content for the current task. Keep the useful interaction patterns and remove sections that do not help the report.

The starter demonstrates three dependency-free SVG patterns: an area chart, a pie chart, and a radar/spider chart. Reuse `renderChart`, `renderPie`, and `renderRadar`, replace their sample datasets, and keep each chart's visible legend plus its `<title>`/`<desc>` accessibility summary. Use semantic `--dev3-*` tokens for every series; do not load a charting CDN.

## Print and PDF

Choose Auto, Light, or Dark in the report, then print normally with Cmd/Ctrl+P. The print stylesheet preserves that selected theme and chart colors, removes interactive controls, compacts the grid, repeats table headers, and avoids splitting cards or rows where possible.

- Keep `print-color-adjust: exact` on `html, body`; never force a light palette inside `@media print`.
- Prefer inline SVG for important chart marks. Canvas and CSS-background-only charts can disappear or become blurry in PDF output.
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
- Keep HTML, CSS, SVG, and JavaScript self-contained. Do not load CDNs, remote fonts, analytics, or network data.
- Keep raster images beside or below `index.html` and reference them with relative paths.

Preview the result in dev3 with the icon and any added raster images included:

```bash
dev3 show-artifact ./dev3-artifact-report/index.html \
  --images ./dev3-artifact-report/dev3-icon.png \
  --title "Report title"
```

Pass every other relative raster asset after `--images` too. Artifacts with images download as a ZIP, so the exported report remains portable.
