# 152 — Update-popover changelog needs full history + tags in CI

## Context

The update-ready popover's "what's new" list (decision 148) shipped empty in
v1.37.4 and v1.38.0. The live `stable-macos-arm64-update.json` served
`{"features":[],"featureCount":0,"fixCount":0}`, and the actual v1.38.0 release
run (`gh run 29892305054`) logged exactly that payload.

## Investigation

The payload is generated at release time by `scripts/build-update-changelog.ts`,
which computes the release window as `git diff <prevTag> HEAD -- change-logs`,
where `prevTag` = newest `v*` tag `--merged HEAD`. Every `actions/checkout@v5` in
`.github/workflows/release.yml` was bare: the CI log shows `fetch-depth: 1`,
`fetch-tags: false`, `git fetch --no-tags --depth=1`. With no tags, `prevTag` is
`null`, the changed-key set is empty, and `selectReleaseWindow` falls back to the
"newest single-date batch". For v1.38.0 that batch was one `chore` entry
(2026-07-22) → zero features/fixes. `generate-changelog.ts` logged `1005 entries`,
so `changelog.json` itself was fine — only the git-tag window resolution failed.
Decision 148 foresaw this fallback but rated it "slightly off count, low-impact";
in practice it produced a fully empty popover, and it degraded silently
(`build-update-changelog.ts` prints `null` on error, wrapped in `|| echo null`).

The popover is also rendered by the version running *before* the update, so the
feature only becomes visible on the update *after* the one that introduced it
(≤1.37.3 had no renderer). v1.37.4→v1.38.0 was the first update that could have
shown it, and it hit the empty-window bug.

## Decision

1. Add `fetch-depth: 0` to every job that resolves the release window — the four
   build jobs (which run `create-release-artifacts.sh`), plus `prepare` and
   `release` (added below) — so `prevTag` resolves and the diff-based window
   works.
2. One-time carry-over: the v1.38.0 window (11 `feature-` + 7 `fix-` + 2
   `refactor-` entries) was re-dated from `change-logs/2026/07/21/` to
   `2026/07/22/` (`git mv`). Because the window is diff-based, moving the files
   makes them "new since v1.38.0", so the next release folds these missed
   highlights into both the popover and the release page. Users updating from
   v1.38.0 never saw them otherwise (they are already on that code).
3. Visible guard: a "Preview update popover changelog" step in the `prepare` job
   computes the payload once and writes it to `$GITHUB_STEP_SUMMARY` as a
   formatted "what's new" block, emitting a `::warning::` when the window is
   empty. Makes an empty popover obvious on the run summary instead of silently
   shipping.
4. Full release-page changelog: `scripts/build-release-notes.ts` renders the same
   window as grouped Markdown (Features → Fixes → Refactors, full titles) and the
   `release` job prepends it to the GitHub Release body. The git window
   resolution is shared with the popover via `scripts/release-window.ts`; the
   grouping/rendering are pure functions in `src/shared/update-changelog.ts`
   (`buildReleaseNotesSections`, `renderReleaseNotesMarkdown`), unit-tested.

## Risks

- Carry-over re-dates shipped entries to 2026-07-22, so the full Changelog screen
  groups them under that date instead of 07-21. Cosmetic; 07-22 is also v1.38.0's
  actual tag date. This is a deliberate one-off, not a mechanism.
- The silent-fallback design still masks future failures. A follow-up guard
  (fail/warn loudly when `prevTag` is null on a tagged release) was deferred.

## Alternatives considered

- `fetch-tags: true` with shallow depth — rejected: the tag ref would exist but
  `git diff <prevTag> HEAD` needs `prevTag`'s commit history, absent in a shallow
  clone.
- Explicit carry-forward list consumed by `build-update-changelog.ts` — keeps
  original dates but adds temporary pipeline code for a one-off; rejected in favor
  of the simpler file move.
- Touch (trivially edit) the 07/21 files to force them into the diff — rejected:
  arbitrary no-op edits to shipped copy, confusing in review.
