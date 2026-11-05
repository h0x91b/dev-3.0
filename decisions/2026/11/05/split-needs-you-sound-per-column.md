# One chime toggle per needs-you column

Supersedes the "one toggle per status" rejection in
`decisions/2026/10/19/task-needs-you-sound.md`; everything else there still holds.

## Context

`playSoundOnTaskNeedsYou` gated the chime for both Your Review (`review-by-user`)
and Has Questions (`user-questions`). The earlier record rejected one toggle per
status because both columns "mean the same thing to the user". They do not: Has
Questions means the agent is blocked until the user answers, while Your Review is
entered at the end of almost every agent turn. A user who wanted a chime only when
an agent is blocked could not get one (issue #2188).

## Decision

- **Two settings replace the one:** `playSoundOnTaskQuestions` and
  `playSoundOnTaskReview`, both opt-in (off unless an explicit `true`, and only
  `true` is stored), the same default the old setting had on `main`.
  `isTaskSoundEnabled` (`src/shared/task-sound-statuses.ts`) checks the one that
  matches the status, so `emitTaskSound` and the debug probe need no change.
- **Migration in `normalizeSettings` (`src/bun/settings.ts`):** each new key falls
  back to the legacy `playSoundOnTaskNeedsYou` while it is absent, so a legacy
  `true` turns on both and a legacy `false` or no key leaves both off. The legacy
  key is not carried into the normalized object, so the next save drops it from
  disk.
- Settings → Notifications shows one toggle per column in place of the old one.

## Risks

An older co-installed build reads only `playSoundOnTaskNeedsYou`. Once a newer build
has saved settings, that key is gone and the older build treats the chime as off.
Nothing turns on that the user did not turn on.

## Alternatives considered

Default both to on: PR #2128 proposed that for the single toggle and was closed
unmerged, so the split keeps the opt-in default. Keeping `playSoundOnTaskNeedsYou`
alongside a new questions-only flag: two settings would overlap for the same column.
