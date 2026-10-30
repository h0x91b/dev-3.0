# The needs-you chime is on by default

## Context

`decisions/2026/10/19/task-needs-you-sound.md` shipped the Your Review and Has Questions chime as opt-in, because those moves happen at the end of every agent turn and an install that never chose should not get a chime many times a minute. Users who want the ping when an agent asks a question were not hearing it unless they found the toggle under Settings → Notifications.

## Decision

- `isTaskSoundEnabled` treats `playSoundOnTaskNeedsYou` as opt-out: it plays unless the value is an explicit `false`. The completion chime already worked this way.
- `normalizeSettings` stores only an explicit `false`, the same shape as every other non-default setting, so an install that never touched the toggle keeps `undefined` and gets the new default.
- The Settings toggle reads `!== false`, so it shows On for installs that never chose.

## Risks

Installs that never chose get a chime at the end of every agent turn that moves a task into Your Review or Has Questions, starting with the update. The toggle is the only way to silence it.

## Alternatives considered

Keep opt-in and make the setting more discoverable: leaves the reported gap, since the ping is the feature people asked for. Turn it on for Has Questions only, with its own setting: more code for a split the user did not ask for.
