# `dev3 show-media` replaces `dev3 show-video` and files audio in its own `sharedAudio` field

## 1. Context
`dev3 show-video tone.mp3` failed with `Unsupported video type "mp3"; Use mp4, webm`. The ask was one canonical command for video and audio, replacing `show-video` outright (no alias, per the no-deprecation rule), reusing the audio support the artifact pipeline and file preview already had (`SHARED_AUDIO_EXTS`, `FilePreviewMedia`).

## 2. Investigation
Measured on macOS 26.6 in a real windowed `WKWebView` over an HTTP Range server (an offscreen or `file://` WKWebView never loads media at all, which looks like "unsupported" but is not): MP3, M4A (AAC), WAV, OGG Vorbis, OGG Opus and FLAC all reach `loadedmetadata`; so do MP4 H.264/HEVC and WebM VP8/VP9. `canPlayType` answers "maybe" for every one of them, so it proves nothing. The version that shipped `sharedVideos` merges that list into the viewer and reads any entry whose mime is not `video/*` through `readImageBase64`, which loads the whole file with no cap.

## 3. Decision
`dev3 show-media` (`src/cli/commands/show-image.ts`, socket `ui.show-media`) accepts `SHARED_MEDIA_EXTS` = MP4/WebM + MP3/M4A/WAV/OGG — the same list artifacts accept, so one constant governs both. `saveSharedClips` (`src/bun/shared-images.ts`) sniffs each container's magic bytes (`hasClipSignature`); it proves the container, never the codec, which the player reports by `onError`. Videos still append to `Task.sharedVideos`; audio goes to a new additive `Task.sharedAudio`, because putting an MP3 in `sharedVideos` would make the previous release read up to 300 MB of it as a base64 image. `taskSharedMedia` merges all three lists; mark-read covers all three. The stream route, module and RPC were renamed to `/shared-media/`, `shared-media-stream.ts`, `getSharedMediaUrl`. `TaskImageViewer` renders `<audio controls preload="metadata">` for audio.

## 4. Risks
Older app versions never see audio (no badge, no tile) — the intended degradation. An old CLI binary calling `ui.show-video` against a new app now fails; the CLI ships with the app, so that only happens with a stale `dev3` on PATH. FLAC and Opus-in-WebM decode in WKWebView 26 and Chromium but stay out until WebView2 and WebKitGTK are measured. WebM from ffmpeg reports `duration` 0 in WKWebView (seen for VP8 and VP9), so its seek bar may not work there; unchanged by this task.

## 5. Alternatives considered
Extending `show-video` to take audio: rejected by the user in favour of a neutral name. Keeping `show-video` as an alias: forbidden by the no-deprecation rule. Audio inside `sharedVideos`: one field less, but the eager-read hazard above. A pre-check with `canPlayType`: "maybe" for everything in WKWebView and `""` for everything in happy-dom, so it would only add false negatives in tests.
