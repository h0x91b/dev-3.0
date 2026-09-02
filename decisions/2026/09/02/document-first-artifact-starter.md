# Document-first artifact starter, document primitives in the shell, directory publish

## Context

The v1 artifact starter (`src/assets/artifact-template/`) shipped as a dashboard demo — four charts, a scenario form, a chart gallery, a sortable table — while the reports agents actually publish are written documents. A count over the 359 artifacts of this project on the maintainer's machine: 306 built on the starter, 55 of them call `dev3Artifact.chart()`, 160 dropped `report.js` entirely, and 59 wrote their own `<style>` block, re-inventing `.shot`, `.callout`, `.steps`, `.legend`, `.progress`, `.term` because `app.css` had no rule at all for `pre`, `code`, `kbd`, `blockquote`, `ul`/`ol`, `h3`, `details`, or `figcaption`. An agent read ~50 KB (`AUTHORING.md` 25 KB + `index.html` 10 KB + `report.js` 15 KB) before writing a line, then deleted most of the demo. `.evidence-table` right-aligned every cell, so one review report carried `class="wrap"` 31 times.

## Decision

- **The starter is a written report.** `index.html` is the skeleton of a document — verdict KPIs, summary with a callout, a `data-sortable` findings table, `ol.steps` with a `pre`, one chart, a decision — on `main.app.doc` (960px). `report.js` holds one chart. Dashboard material (forms, gallery, popover menu) lives as paste-in snippets in `REFERENCE.md`; the Choices/noUiSlider CDN tags moved there with it, so a static report loads only ECharts. `src/bun/__tests__/artifact-template.test.ts` caps `index.html` at 9 KB and `report.js` at 2 KB so the demo cannot grow back.
- **Document primitives in `app.css`**, all colored through `--dev3-tone` or the semantic tokens: `code`/`kbd`/`pre` (pre wraps, never scrolls — the table rule), `mark`, `blockquote`, `details`/`summary`, `h3`/`h4`, lists, `.callout[.good|.warn|.bad]`, `ol.steps`, `figure.shot`, `.pair`, `.legend`/`.swatch`, `.progress`, `.pill.danger|.muted`. Text is the table default; `.num` opts a column into right alignment (`.evidence-table` included; `.wrap` stays as a no-op plus the stacked full-width rule).
- **The shell sorts a `<table data-sortable>`** in place (`sortRowsInPlace` in `app.js`, `data-sort` on a cell overrides its text), so a report whose rows live in the markup needs no JavaScript. Opt-in, because the old demo re-rendered rows from data and sorted itself.
- **`AUTHORING.md` is a card** (< 8 KB, enforced): files, workflow, a "you want → write" class table, color families, the two chart traps, the contract, and an index of `REFERENCE.md` sections with "read when". `REFERENCE.md` is a new managed file in `ARTIFACT_TEMPLATE_FILES`.
- **`dev3 show-artifact <dir>`** publishes `index.html` plus every CSS/JS/raster file under the directory (`collectDirectoryAssets` in `src/cli/commands/show-artifact.ts`), skipping dotfiles and `node_modules`. Only a directory is walked — a bare `.html` keeps the explicit `--assets` contract, so a report sitting in a worktree root cannot slurp the repository. An explicit `--assets` list wins over the walk. The protocol step 4 and the help text now show the directory form.

## Risks

Old artifacts carry their own copy of the shell, so nothing published changes; a report that mixes a new `index.html` with an old `app.css` (a stale copy of the starter) renders the primitives unstyled but intact — plain HTML degrades to plain HTML. The evidence-table alignment flip only affects reports built from this shell onward. The directory walk is capped by `MAX_SHARED_ARTIFACT_ASSETS` (40) and names the count on overflow.

## Alternatives considered

Two starters (`document/`, `dashboard/`) — rejected: a second file set to maintain and more protocol text under the Windows command-line budget. Leaving the starter and only adding CSS — rejected: the agent would still read and delete 15 KB of simulator per report. Auto-collecting assets for a bare `.html` when it carries the template marker — rejected in favour of the explicit directory form, because "which files ride along" must be predictable from the command line alone.
