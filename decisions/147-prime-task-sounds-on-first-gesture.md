# 147 — Prime task-completion sounds on the first user gesture

## Context
In remote browser mode the completion sound never played on desktop Chrome,
while the same task on mobile Chrome played fine. Non-UI completions (agent
approval, CLI, branch-merge) reach a remote renderer only via the backend
`taskSound` push, which lands seconds after the user's "Approve" click because
the backend tears the worktree down first.

## Investigation
`playTaskSound` (`src/mainview/task-sounds.ts`) played a fresh
`template.cloneNode()` `<audio>`. That clone was never user-activated, and by the
time the push arrived the click's transient activation had expired, so desktop
Chrome's autoplay policy rejected the delayed `.play()`. Mobile Chrome unlocks
media stickily after a single gesture, so its delayed play was honored — hence
the asymmetry. The old unlock handler also never primed anything: on an empty
queue it just flipped `playbackUnlocked` and removed itself.

## Decision
Prime each sound element (a muted play/pause) synchronously inside the first
user gesture (`primeTemplates` in `task-sounds.ts`, called from the
`installUnlockHandlers` listener), and play by reusing the primed template
instead of an un-activated clone. Once primed, desktop Chrome honors later
push-driven plays.

## Risks
Same-status completions can no longer overlap (one element per status) — a
non-issue for completion sounds. If the user never makes any gesture in the tab,
nothing can unlock playback — an unavoidable browser-policy limit; the sound
still queues and plays on the next gesture.

## Alternatives considered
- Rewrite to Web Audio API (`AudioContext` resumed on gesture): most robust but a
  larger change and hard to unit-test under happy-dom. Kept as the fallback if
  priming proves insufficient on some browser.
- Play optimistically inside the "Approve" click handler: the outcome is unknown
  at click time, and CLI / branch-merge completions have no gesture at all.
