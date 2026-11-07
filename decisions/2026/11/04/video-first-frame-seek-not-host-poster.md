# Paint a video's first frame with a tiny seek, not a host-made poster

## Context
`dev3 show-media` clips rendered as a black box with a play button until played. The players already used `preload="metadata"` over a Range-served URL, and the server answers ranges correctly.

## Investigation
Reproduced in Playwright WebKit with the same element attributes: WebKit stops a `preload="metadata"` video at `readyState` 1 (HAVE_METADATA) and never decodes a frame; Chromium goes on to 4 by itself, so the bug never shows in a Chromium browser. Seeking to 0.001 s on `loadedmetadata` (or a `#t=0.001` fragment) moves WebKit to `readyState` 4 and paints frame one, for faststart and moov-at-end files alike.

## Decision
`primeFirstFrame()` (`src/mainview/utils/video-first-frame.ts`) seeks a paused, untouched video to 0.001 s on `loadedmetadata`; the viewer stage (`TaskImageViewer`) and the file preview (`FilePreviewMedia`) call it. Thumbnails (`VideoFrameThumb`, used by the viewer rail and `SharedOutputsList`) load only once on screen, two at a time, run the same seek on a hidden muted video, copy the frame onto a canvas and then release the video, so many clips hold pixels rather than a decoder and a connection each.

## Risks
A thumbnail still pulls the moov box plus one range (capped at 8 MB by `serveFileBytes`) per clip. A tainted canvas (cross-origin desktop URL) still displays; we never read its pixels back.

## Alternatives considered
A poster generated on the host needs ffmpeg, which is not guaranteed on in-app-updated installs. The `#t=0.001` URL fragment works too but changes the capability URL that Download and Copy reuse. Keeping a live `<video>` per thumbnail paints the frame but keeps a decoder and connection alive per tile.
