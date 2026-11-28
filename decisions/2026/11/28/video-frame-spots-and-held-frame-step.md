# Numbered frame spots and a held frame step in the video review bar

## Context
Reviewers wanted to point at things on a paused video frame ("#1 is cut off") and to scan a clip frame by frame without tapping a key thirty times a second.

## Decision
Spots are optional `points` (`{ n, x, y }`, 0..1 of the picture, not the element, so letterboxing and fullscreen do not move them) and `still` on `ReviewVideoTimeAnchor` in `src/shared/review.ts` — additive fields older builds ignore. A comment's spots stay on its frame: off that frame the tool seeks back to it rather than re-pinning the draft, which would put spots on content they were never placed on. A spot keeps its number for good; a new one takes the lowest free number (`nextFramePointNumber`), so text that says "#3" never starts pointing elsewhere. The still is drawn from a private `crossOrigin="anonymous"` copy of the clip (`src/mainview/utils/frame-still.ts`) and saved through `uploadImageBase64`; the player on stage is never switched to CORS mode. A held ±1 frame button or `,`/`.` (`createFrameStepHold` in `VideoReviewBar.tsx`) steps once, then after 500 ms repeats at half the measured frame rate through the scrub seeker, each step from `intendedTime`, so a slow decode skips frames instead of queueing them.

## Risks
A server path that omits `Access-Control-Allow-Origin` makes the still silently absent (the comment and spots are still stored). The still is captured right after the comment is added and patched onto it (`setReviewCommentStill`); a clip replaced later is not re-rendered. Stills live in the project `uploads/` dir like pasted images and are not deleted with their comment.

## Alternatives considered
Renumbering spots on removal: breaks references already typed into the comment. Setting `crossOrigin` on the visible player: one missing CORS header would stop playback entirely. Relying on OS key repeat for held keys: its rate is the user's typing setting, not the clip's, and every repeat would abort the previous seek.
