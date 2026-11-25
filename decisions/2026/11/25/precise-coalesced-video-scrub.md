# Precise, coalesced seeks for the video timeline drag

## Context
The media viewer's scrubber called `fastSeek` on every pointer move and a precise seek only on press and release. Users saw a paused picture stay put while dragging.

## Investigation
Driving the real viewer in WebKit (seeded QA board, 282 MB H.264 clip, 20 s GOP): 61 `fastSeek` calls produced 61 `seeked` events but only 4 presented frames, all at keyframes (0 s, 20 s). WebKit honours `fastSeek`'s tolerance by snapping to a sync sample, so on a sparse-GOP clip (screen recordings, long encodes) the picture does not move between keyframes. The same drag with `currentTime` presented 40 frames that tracked the pointer. Chromium has no `fastSeek`, which is why the bug never showed there.

## Decision
`createScrubSeeker` in `src/mainview/components/VideoReviewBar.tsx`: every press, move and release seeks precisely via `currentTime`, with at most one seek in flight; targets arriving meanwhile overwrite a single pending slot that is applied on `seeked`. The decoder never queues more than one GOP decode, so long files stay smooth.

## Risks
A precise seek on a very long GOP is slower than a keyframe snap, so on a slow disk the picture trails the pointer by one seek. A seek that never fires `seeked` (element torn down) leaves the pending slot unused, which is harmless.

## Alternatives considered
Keep `fastSeek` with a trailing precise seek after a pause in movement: still frozen while moving. Throttle by time (rAF / 50 ms): either piles up seeks on slow decodes or wastes time on fast ones; gating on `seeked` adapts to the actual decode cost.
