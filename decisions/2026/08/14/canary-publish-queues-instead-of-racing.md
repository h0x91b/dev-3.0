# Canary publishing queues instead of racing

## Context

`canary-publish.yml` deliberately had no `concurrency:` block: its header argued that "a cron
that compares a sha has no burst to collapse". That held at 60-minute spacing against a run
measured at 11m09s. Speeding the cron to every 20 minutes (temporary, at Arseny's request on
2026-08-14, while Windows is shaken out on canary) removes the margin — scheduled ticks fire
15-30 minutes late as a rule, so a tick can start while its predecessor is still publishing.

## Investigation

Overlapping runs of this workflow are not merely wasteful, they collide on shared state:

- The S3 keys are overwritten in place (`canary-<platform>-update.json`, the payload archives),
  so a manifest from one run can land over payloads from the other.
- `scripts/publish-canary-release.ts` refreshes the rolling `canary` pre-release and **merges**
  `canary-assets.json` rather than replacing it, so two writers race that ledger.
- The likeliest collision is not two different shas. `decide` compares main against the
  *published* feed, and the first run has not published yet — so the second run rebuilds the
  **same sha**, paying a full sign-and-notarize cycle for a duplicate.

## Decision

Added a workflow-level group in `.github/workflows/canary-publish.yml`:
`concurrency: { group: canary-publish, cancel-in-progress: false }`.

Queueing, not cancelling. A queued run starts after the first has published, its probe then
sees a matching sha, and every platform skips — nearly free. `cancel-in-progress: true` was
rejected: killing a publish mid-flight can leave a half-written manifest authoritative, which
is worse than the race it prevents.

## Risks

GitHub keeps at most one pending run per group and cancels an older pending one. Under a burst
of late ticks a tick can therefore be dropped — harmless here, because a pending run has built
nothing and the next tick still sees the sha mismatch, the same property that makes a missed
cron tick harmless. Manual `workflow_dispatch` runs also queue behind a scheduled run.

## Alternatives considered

- **No concurrency at all** (the previous state) — the argument for it was explicitly the
  hourly spacing, which no longer applies.
- **`cancel-in-progress: true`** — rejected above; it trades a rare interleave for a
  guaranteed partial write.
- **A per-sha group (`canary-publish-${{ github.sha }}`)** — would let two runs on different
  shas overlap, which is exactly the case that races the bucket keys and the ledger.
