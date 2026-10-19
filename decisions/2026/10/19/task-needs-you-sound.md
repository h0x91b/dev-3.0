# A separate, opt-in chime for tasks that need the user

## Context

Only `completed` and `cancelled` played a sound. Issue #2005 asks for one when a
task lands in Your Review (`review-by-user`) or Has Questions (`user-questions`),
because the agent is then waiting on the user. Almost all of those moves come from
agent hooks and the CLI, not from the board.

## Decision

- **One new setting, `playSoundOnTaskNeedsYou`, off unless an explicit `true`.**
  `isTaskSoundEnabled` in `src/shared/task-sound-statuses.ts` is the single gate
  for both families, used by `emitTaskSound` (executor) and the debug probe.
  `playSoundOnTaskComplete` keeps its old default and meaning.
- **Why off by default:** these moves happen at the end of every agent turn, so
  with several agents running the chime can fire many times a minute. Turning it
  on for every existing install with an update would be a surprise; the
  completion chime, which fires once per task, stays on.
- **The machine emits it** (`needsYouSoundEffects` in `lifecycle/machine.ts`) for
  a plain move and for the AI-review fallback, only when the status changes into
  one of the two columns, and **after `persistColumn`**: a guard-rejected hook
  write stops the effect chain, so a refused move never chimes.
- **A move the user makes from the UI never chimes.** `moveTaskToStatus` sends
  `clientPlayedSound: true` for those two columns and plays nothing: the user
  just did it themselves, and the existing flag is what stops the backend push.
- **The asset** `src/assets/sounds/task-needs-you.mp3` (0.74 s, two rising bell
  partials E5→B5, CBR 192 kbps / 48 kHz) was synthesized with ffmpeg's
  `aevalsrc` for this repo, so it has no third-party license. It stays under the
  0.95 s Now Playing threshold (`task-sounds-back-to-short-audio-elements.md`),
  and the existing duration test covers it because it reads every `SOUND_DEFS`
  entry. Both statuses share it.

## Risks

A hook that bounces a task between the two columns chimes on each bounce. The
renderer ignores a pushed status it has no chime for, which only matters for a
remote tab left open across an update.

## Alternatives considered

One toggle per status: more settings for no clear gain, since both columns mean
the same thing to the user. Reusing `playSoundOnTaskComplete`: would turn the
chime on for everyone and could not be switched off separately. Chiming on UI
moves too: announces something the user just did.
