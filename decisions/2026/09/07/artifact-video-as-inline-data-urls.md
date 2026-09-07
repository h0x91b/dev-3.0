# Bundled artifact video ships as an inline data URL, with a blob retry

## Context

An artifact reaches the viewer as one composed `srcdoc` document inside an
opaque-origin sandboxed iframe (`ArtifactFrame`). There is no origin, so a
relative `src` resolves to nothing; every copied asset is therefore delivered as a
base64 data URL over one RPC reply (`readArtifactContent` →
`loadSharedArtifactContent`) and substituted into the stored HTML text
(`composeArtifactDocument`). Adding MP4/WebM to that path means video pays the
same delivery model as a stylesheet — 1.34× its bytes in the payload, again in the
document string, on every open rather than on first play.

## Investigation

Measured in headless Chromium 143 with the app's exact frame setup
(`sandbox="allow-scripts"`, `srcdoc`, no `allow-same-origin`): an H.264/AAC MP4 and
a VP9 WebM both load metadata from a `data:` URL, play, advance and seek to an
arbitrary time. Programmatic `play()` on an unmuted clip is rejected with
`NotAllowedError` — the ordinary user-gesture policy, not an artifact limitation;
muted playback starts without a gesture.

Representative encodes (ffmpeg `testsrc2`, high-entropy worst case, 720p30): 2.7 MB
for 8 s, 5.0 MB for 15 s. A real screen capture of the same length lands well under
that. The presentation use case that prompted this is 4–5 silent clips of 6–12 s.

## Decision

Video is an ordinary artifact asset: `SHARED_VIDEO_EXTS` (`mp4`, `webm`) joins
`SHARED_ARTIFACT_ASSET_EXTS`, `MIME_BY_EXT` in `src/bun/shared-artifacts.ts` gains
`video/mp4` and `video/webm`, and the existing `src`/`poster` rewrite already covers
`<video src>`, `<source src>` and `<video poster>` with no new markup contract. Two
additions:

- **Tighter caps of their own** — `MAX_SHARED_ARTIFACT_VIDEO_BYTES` (16 MB per clip)
  and `MAX_SHARED_ARTIFACT_VIDEO_TOTAL_BYTES` (48 MB per artifact), enforced in both
  the CLI (`src/cli/commands/show-artifact.ts`) and the authoritative bun path, with
  an error that names the file, its size and the remedy. The generic 25 MB asset cap
  and 100 MB combined cap stay for everything else.
- **A blob retry** in the injected asset runtime (`VIDEO_BLOB_FALLBACK` in
  `src/mainview/utils/artifactDocument.ts`): on a media `error` the element's
  `data:video/*` sources are re-fetched into blob URLs once and the element reloaded.
  WebKit has a long history of refusing media from a `data:` URL, and the failure has
  no symptom other than `MEDIA_ERR_SRC_NOT_SUPPORTED`. The bytes are already in the
  document, so the retry costs one local fetch and no round trip.

## Risks

- Bytes are still paid at open, not at play. `preload="metadata"` (documented in the
  template reference) prevents eager *decoding*, never the transfer, so a 48 MB
  artifact opens slowly. The caps are what keep that bounded; if it becomes a real
  complaint the fix is lazy per-asset delivery over the artifact channel, not a
  bigger cap.
- WKWebView playback was verified only through the retry's reasoning, not measured —
  see the task report for exactly what was and was not driven.
- A report directory now sweeps up any `.mp4`/`.webm` beside it, which can surprise
  an author who parked a recording there. It fails loudly on the caps rather than
  publishing quietly.

## Alternatives considered

- **A lazy `readArtifactAsset` RPC per clip.** Best for open time and memory, and
  the natural follow-up, but it adds a second delivery path, a new channel message
  and a loading state to a viewer that currently has exactly one.
- **Blob URLs as the primary source.** Cheaper memory and native seeking, but the
  blob URL cannot exist at compose time, so the markup would need a placeholder
  attribute and every video would start with a deliberately failed load.
- **Transcoding oversize clips.** Rejected outright: silently re-encoding a user's
  file is not something a publish step gets to do.
