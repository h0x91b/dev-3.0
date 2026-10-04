# Site changelog is generated at Pages deploy, attributed by tag tree

## Context
The landing site (`docs/`, GitHub Pages) had no changelog page; third-party catalogs read that as "vendor publishes no changelog". Release notes already exist (GitHub Releases, `change-logs/`), so the page must reuse them, not duplicate them by hand.

## Investigation
GitHub Release bodies use the release window (`scripts/release-window.ts`: files *changed* since the previous tag). That double-counts an entry edited in a later window and drops entries of tags whose release never published (e.g. `v1.50.0`, `v1.55.0` have tags but no Release). 216 Releases exist for 251 `v*` tags.

## Decision
`scripts/generate-site-changelog.ts` writes `docs/changelog/index.html` (gitignored) inside `.github/workflows/pages.yml`: releases and dates from `gh release list` (published, non-prerelease `v*`), and each current entry is credited to the first release whose tag tree contains its file name (`src/shared/site-changelog.ts`, `assignEntriesToReleases`). Pages now also redeploys after every successful `Release` run (`workflow_run`). Unreleased entries are omitted.

## Risks
The page can disagree slightly with a GitHub Release body for the reasons above — by design. A generator failure fails the Pages job instead of deploying without the page. Needs full history (`fetch-depth: 0`).

## Alternatives considered
Committing the generated HTML (goes stale, noisy diffs); fetching the GitHub API from the browser (rate limits, invisible to crawlers); reusing the release-window logic (inherits the double-count and the lost windows).
