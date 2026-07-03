# 101 — UX skill doc diet: zero-write default, three canonical manifest files

## Context

The `ux-principal` / `ux-create-manifest` skills accumulated ~456 KB under `docs/ux/` in
two months: 20 never-reread `feature-plans/*.md` (232 KB), a `UX_MANIFEST_CHANGELOG.md`
duplicating `git log`, a stale one-shot `UX_AUDIT_REPORT.md`, and a 100 KB
`UX_DECISIONS.md` with essay-length entries. Recent PRs carried 5-9 doc files each
(one had 6 doc files vs 5 code files), and every planning run had to read ~200 KB of
manifest context to place a single button.

## Investigation

Root causes in the skills themselves: `ux-principal` step 7 read as an unconditional
checklist (append decisions + changelog + plan file on every feature), `report-format.md`
mandated persisting each report as `feature-plans/<feature>.md`, and nothing ever
compacted or retired anything.

## Decision

The skills' default write count is now ZERO: the UX Principal Report is chat/PR output;
files are touched only when an explicit architecture-change gate passes (new destination,
surface, placement rule, budget exception, token role, or object). Canonical on-disk
footprint is exactly three files: `PRODUCT_UX_BIBLE.md` (glossary folded in as §14),
`ux-architecture.yaml`, `UX_DECISIONS.md` (entries capped ~5 lines, file ~35 KB with a
compaction duty). Deleted from the repo: `docs/ux/feature-plans/` (content preserved in
git history), `UX_MANIFEST_CHANGELOG.md`, `UX_AUDIT_REPORT.md`, `UX_GLOSSARY.md`;
`UX_DECISIONS.md` compacted 100 KB → ~29 KB with stale `Planned`/`Proposed` statuses
corrected against shipped code.

## Risks

Historical docs (`decisions/069/084/097/098`, old change-logs) still mention deleted
`feature-plans/*` paths — accepted as archival references resolvable via git history.
Losing per-feature plan files means the full interaction contract lives only in PRs;
if that proves insufficient, plans can go in task descriptions, never back in the repo.

## Alternatives considered

Commit-then-delete-on-ship plan files (still churns every diff; agents forget the delete
step); dropping `UX_DECISIONS.md` entirely (loses the why-trail); keeping the changelog
(pure `git log` duplication). Rejected in favor of the zero-write default.
