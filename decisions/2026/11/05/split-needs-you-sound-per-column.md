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
  `playSoundOnTaskReview`, both opt-in (off unless an explicit `true`), the same
  default the old setting had on `main`. `isTaskSoundEnabled`
  (`src/shared/task-sound-statuses.ts`) checks the one that matches the status, so
  `emitTaskSound` and the debug probe need no change.
- **Migration:** `resolveNeedsYouSoundToggles` (same file) seeds each toggle not yet
  stored as a boolean from the legacy `playSoundOnTaskNeedsYou`, so a legacy `true`
  turns on both and a legacy `false` or no key leaves both off. Explicit `false` is
  kept, so the legacy key can never bring a switched-off chime back.
  `normalizeSettings` and the `saveGlobalSettings` handler both use it; the handler
  lets stored choices win, so a remote tab still holding a pre-split snapshot cannot
  overwrite them.
- **Older builds keep reading the file (on-disk N-2 rule):** `saveSettings` writes
  `playSoundOnTaskNeedsYou` as `true` only while both new toggles are on. An older
  build that saves drops the new keys; this build then falls back to its legacy value.
- Settings → Notifications shows one toggle per column in place of the old one.

## Risks

An older co-installed build has only one toggle, so with just one column on it stays
silent: it never chimes more than the user asked for. Its saves reset the split to its
single choice.

## Alternatives considered

Default both to on: PR #2128 proposed that for the single toggle and was closed
unmerged, so the split keeps the opt-in default. Keeping `playSoundOnTaskNeedsYou`
alongside a new questions-only flag: two settings would overlap for the same column.
