# 148 — "What's new" changelog in the update-ready popover

## Context

The header "Update" plaque popover (`GlobalHeader.tsx`) previously showed only the
version + a Restart button. We wanted a short "what's new" preview for the version
being installed. The app already has a full Changelog screen, but its data is the
*currently installed* bundle — it cannot know the new version's entries. So the
what's-new must travel with the update.

## Decision

Embed a compact, features-first payload in the release `update.json`
(`{ features: string[], featureCount, fixCount }`) and carry it through the existing
`updateAvailable` push to the renderer. The popover shows up to
`MAX_POPOVER_FEATURES` (5) feature titles + a "+N more · M fixes" rollup + a link to
the full Changelog screen (progressive disclosure — the popover is a preview, not a
list; see UX manifest §5 Popover surface).

- `update.json` is our own file, fetched by plain `fetch()` in `checkForUpdateWithChannel`
  (`src/bun/updater.ts`); Electrobun's own updater ignores the extra field. Not an
  Electrobun capability question.
- Release window (what counts as "this version") = changelog files changed since the
  previous `v*` git tag (`scripts/build-update-changelog.ts`), with a fallback to the
  most-recent-day batch when git/tags are unavailable (shallow CI checkout). Prints
  `null` on any error so a broken build step never breaks the update flow.
- Titles: a new optional `Short:` line in each `change-logs/*.md` (≤6 words) — full
  changelog titles (median 120 chars) are unreadable in a 288px popover. Mandatory for
  `feature-` entries; `fix-` entries fall back to a crude word-capped derivation
  (`deriveShortTitle`). Only the ~most-recent entries were backfilled — the popover
  only ever shows the newest release's window, so history needs no `short`.

Pure logic in `src/shared/update-changelog.ts` (tested); the popover section is
conditional, so a missing/`null` changelog renders the old popover unchanged
(backward compatible with pre-changelog `update.json` and cross-channel updates).

## Risks

- The release window is approximate when git tags are missing (fallback batch). The
  popover is explicitly a preview and links to the full changelog, so a slightly off
  count is low-impact.
- `Short:` discipline is convention-enforced (README + AGENTS.md), not validated in CI.
  The derived fallback bounds the downside to ugly-but-safe.

## Alternatives considered

- Reuse the bundled `getChangelogs()` — rejected: it's the installed version's log, not
  the incoming one.
- Separate `changelog.json` on S3 + date filtering — rejected: extra file + fetch for no
  gain over embedding a small window in `update.json`.
- Cram full titles / first-few-words — rejected: full titles wall-of-text a 288px
  popover; first words are generic verbs ("Fixed the…", "Added a…").
