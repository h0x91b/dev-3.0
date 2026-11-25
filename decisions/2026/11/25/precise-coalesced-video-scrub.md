# Precise, coalesced seeks for the video timeline drag

## Context
The media viewer's scrubber called `fastSeek` on every pointer move and a precise seek only on press and release. Users saw a paused picture stay put while dragging.

## Investigation
In WebKit, `fastSeek` is honoured by snapping to a sync sample, which holds the picture on the previous keyframe for backward drags and long jumps (forward drags inside one GOP still moved). Measured on a 60 s GOP clip, paused: a backward drag presented 1 frame, a full sweep 2. Chromium has no `fastSeek`, so it took the `currentTime`-per-move path, and that froze too: every new seek aborts the one in flight, so 0 frames were presented until release. A 282 MB, 20 s GOP clip showed the same in the real viewer (61 seeks, 3 frames).

## Decision
`createScrubSeeker` in `src/mainview/components/VideoReviewBar.tsx`: every press, move and release seeks precisely via `currentTime`, with at most one seek in flight; newer targets overwrite one pending slot that is written on `seeked`. Two seeks the seeker did not issue must win over that slot: a `seeking` event whose `currentTime` is not the seeker's own last write (5 ms tolerance; measured readback error is under 1 µs) drops it, and relative seeks (J/L, arrows, frame step) start from `intendedTime(video)`, the pending target, so L right after letting go at 10 s lands on 25 s, not 15 s past the seek still in flight. While dragging, the thumb and readout show the pointer, not the seek.

## Risks
On a long GOP the picture trails the pointer by one precise seek (several seconds per presented frame on a backward drag over a 60 s GOP); the thumb does not. A seek written straight to `currentTime` by new code bypasses `intendedTime` and starts from the in-flight position.

## Alternatives considered
Keep `fastSeek` with a trailing precise seek after a pause in movement: still frozen while moving. Throttle by time (rAF / 50 ms): either piles up seeks on slow decodes or wastes time on fast ones; gating on `seeked` adapts to the actual decode cost. Routing every seek through the seeker: more invasive than the `seeking` check, which also covers marker clicks and future callers.
