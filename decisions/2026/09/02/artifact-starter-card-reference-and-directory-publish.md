# Artifact starter: a one-screen card plus a reference, shell-sorted tables, directory publish

## Context

A count over the 359 artifacts of this project on the maintainer's machine: 306 built on the v1 starter, 55 of them call `dev3Artifact.chart()`, 160 dropped `report.js` entirely, 59 wrote their own `<style>` block. Before writing a line an agent read ~50 KB — `AUTHORING.md` (25 KB) plus the demo `index.html` and `report.js` — and then published with a six-line command naming five asset paths, the step most often got wrong.

## Investigation

A document-first restyle of the starter (new skeleton, document primitives in `app.css`, text-aligned tables, a 960px `.doc` width) was built, screenshotted before/after and shown live; the maintainer preferred the existing visual and asked to keep only the functional parts. The visual files (`index.html`, `report.js`, `app.css`) are therefore byte-identical to the previous release.

## Decision

- **`AUTHORING.md` is a one-screen card** (< 8 KB, enforced by `src/bun/__tests__/artifact-template.test.ts`): files, the three-line workflow, a "you want → write" table of the classes the shell already has, the color families, the two chart traps, the contract, and an index of `REFERENCE.md` sections with "read when". Everything deeper moved verbatim into a new managed `REFERENCE.md` (added to `ARTIFACT_TEMPLATE_FILES`), so the reference is read by section, on demand.
- **The shell sorts a `<table data-sortable>`** in place (`sortRowsInPlace` in `app.js`; a cell's `data-sort` overrides its text, comparison is numeric-aware). Opt-in, because the demo and many reports render rows from data and sort themselves.
- **`dev3 show-artifact <dir>`** publishes `index.html` plus every CSS/JS/raster file under the directory (`collectDirectoryAssets` in `src/cli/commands/show-artifact.ts`, dotfiles and `node_modules` skipped, capped by `MAX_SHARED_ARTIFACT_ASSETS`). Only a directory is walked — a bare `.html` keeps the explicit `--assets` contract so a report in a worktree root never slurps the repository. An explicit `--assets` list wins over the walk. Protocol step 4 and the CLI help show the directory form.

## Risks

The starter still ships as a dashboard demo that most reports gut; the card says so and the token cost of that is now the `index.html` + `report.js` pair alone. Old artifacts carry their own shell copy and are untouched.

## Alternatives considered

A document-first starter with document primitives — built, shown, rejected by the maintainer on visual grounds. Two starters (`document/`, `dashboard/`) — rejected: a second file set to maintain and more protocol text under the Windows command-line budget. Auto-collecting assets for a bare `.html` when it carries the template marker — rejected in favour of the explicit directory form, because "which files ride along" must be predictable from the command line alone.
