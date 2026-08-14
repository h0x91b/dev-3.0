# One rolling `canary` pre-release, not one release per publish

## Context

Canary builds existed only as keys in the S3 update bucket. A person who wanted to shake out a
canary build had no page to visit and had to be handed a raw bucket URL by hand. On Windows that
is the *only* bootstrap there is: `src/bun/updater.ts` refuses a cross-channel switch on every
non-macOS platform (the running app **is** the channel folder there, so an in-place switch would
install where the launcher never starts), and its error text tells the user to "install the other
channel's build once from the releases page" — a page that had no canary build on it.

## Investigation

The cadence had to be measured before the shape could be chosen, because the hourly publisher's
`decide` job skips every platform when `main` has not moved. Over the 145 most recent runs of
`canary-publish.yml`, publishes per day were 3, 9, 5, 1, 3 (Aug 9–13) — **4.2 a day, peak 9**, not
the 24 an hourly cron suggests; 91 of 145 ticks built nothing. `main` itself took 152 commits in
14 days, so several merges collapse into one tick. A release per publish is therefore ~30 entries
a week, which buries every stable release — the opposite of what was asked for.

## Decision

`canary-publish.yml` gained a `release-page` job that refreshes **one** pre-release tagged
`canary`: it moves the tag to the published commit, rewrites the body, and re-uploads the assets
with `--clobber`. Rules live in `src/shared/canary-release.ts`; the I/O is
`scripts/publish-canary-release.ts`. It is always `--prerelease --latest=false`, on both the
create and the refresh path, because `/releases/latest` is resolved by `src/bun/rosetta.ts` and by
every download button on `docs/index.html`.

Two things are attached as **copies, never bucket links**: the canary keys at the bucket root are
overwritten in place, so a link would silently change bytes under whoever downloads it. And each
row of the body names the **run**, not just the commit — Windows trees are not byte-reproducible
(one sha, three runs, a 15-byte spread), so the sha alone does not identify a file. That
provenance lives in a small `canary-assets.json` asset and is merged per file, because a run
rebuilds only the platforms whose own feed is behind.

## Risks

The page orders by date, so the rolling entry sits permanently **above** every stable release
rather than between them; Arseny picked that shape with the consequence stated. Canary history is
not kept on the page — older builds remain in the bucket's per-sha prefix. The versioned canary
prefix still has no retention policy. And the tag `canary` must never fall inside `release.yml`'s
`v*` / `test-*` filters, or every canary publish would start a full stable release including the
Homebrew cask edit; `canary-release.test.ts` pins that against the filters read out of
`release.yml` itself.

## Alternatives considered

**One release per publish** — ~30 entries a week, buries stable, needs a pruning job.
**One per day (`canary-YYYY-MM-DD`)** — the documented fallback if the history is ever wanted:
~7 entries a week genuinely interleaved with stable ones, at ~400 MiB of assets a day.
**Linking the bucket instead of attaching copies** — rejected: root keys are overwritten in place.
