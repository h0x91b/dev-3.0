# `dev3 show-video` keeps clips in an additive `sharedVideos` field and plays them in the image viewer

## 1. Context
Agents wanted to hand the user a QA recording or demo clip the way `dev3 show-image` hands a screenshot, and the ask was explicit: the SAME viewer, switching its stage to a player, not a new panel. The same UI does not require the same list on disk.

## 2. Investigation
Image bytes reach the webview as one base64 data URL over `readImageBase64`, in the desktop bridge and the remote tunnel alike; no authenticated file-serving HTTP route exists. Chromium was measured seeking a `blob:` URL built from those bytes; WKWebView is expected to but unverified. A first cut put clips inside `sharedImages`; the Seq 2003 N-2 review (source inference on tags v1.55.2 / v1.54.1, not measured) found that released viewers and the archived list read the bytes of every `sharedImages` entry eagerly, through an RPC with no size cap, so an older app opening a task with a few 25 MB clips would spend hundreds of MB and draw broken tiles.

## 3. Decision
Clips are `SharedImage` records (a `video/*` `mime`, `isSharedVideo`) in a new top-level `Task.sharedVideos`; every new-version reader goes through `taskSharedMedia(task)` (`src/shared/types.ts`), which merges both lists oldest→newest — badge, inspector sheet row, archived list, push payload, viewer navigation. `ui.show-video` (sharing `showSharedMedia` with `ui.show-image`, `src/bun/cli-socket-server.ts`) appends only to `sharedVideos`; `markTaskSharedItemsRead(kind: "images")` marks ids read in both lists and never creates `sharedVideos` on a task without one. `saveSharedVideo` (`src/bun/shared-images.ts`: MP4/WebM, 25 MB, container-signature sniff) copies into the existing `shared-images/` dir. `TaskImageViewer` renders `<video controls preload="metadata">` (no autoplay) from a `blob:` URL revoked on close, and reads a clip only while it is on stage.

## 4. Risks
Old versions never see clips (no badge, no tiles, no reads) — the intended degradation. Preservation of the field through the old-equivalent write paths (unrelated `updateTask`, image-only mark-read, image append, `moveTaskToProject`) is executed in `shared-videos-preservation.test.ts`; running a real released binary against it was not done. The 25 MB cap is transport-bound (~34 MB base64 per open). Codec support is the engine's and was measured only in headless Chromium (H.264/AAC, VP8, VP9/Opus play; HEVC does not); WKWebView, WebView2 and WebKitGTK are unverified.

## 5. Alternatives considered
Clips inside `sharedImages`: least code, but older apps read their bytes eagerly (above). A range-serving HTTP route: streams any size, rejected for this task as new auth surface. Accepting clips in `show-image`: rejected, it would weaken that command's image-only validation.
