# Artifact audio rides the video path; broken media references stop the publish

## Context

A report with `<audio><source src="audio/A.mp3"></audio>` and `<a href="audio/A.mp3" download>` published "successfully" as a directory, then showed players that never loaded. Audio was not in `SHARED_ARTIFACT_ASSET_EXTS`, so the directory walk skipped every `.mp3` without a word, nothing was copied, and the relative `src` resolved to nothing inside the opaque-origin srcdoc frame. `--assets audio/A.mp3` was refused outright. Download links could never work at all: `<a href>` is not rewritten and the sandbox has no `allow-downloads`.

## Investigation

A throwaway WKWebView harness on macOS 26 decoded MP3, WAV, OGG Vorbis, Opus, M4A and FLAC from `data:` URLs and from blob URLs, with seek and play. The composed document in the viewer's exact frame (`sandbox="allow-scripts allow-popups"`, srcdoc) played, seeked, ended and replayed four MP3s in both WKWebView and headless Chromium, and link clicks reached the parent with the right bytes. Older WebKit was not measured.

## Decision

- `SHARED_AUDIO_EXTS` (`mp3`, `m4a`, `wav`, `ogg`) join the asset allowlist with MIME types in `src/bun/shared-artifacts.ts`; audio and video share the renamed media caps (16 MB per file, 48 MB together). The existing `src` rewrite already covers `<audio src>` and `<source src>`; the runtime healer adds `audio`, and the blob retry covers `data:audio/*`.
- A click on `<a href>` that resolves to a bundled asset is routed to the viewer (`dev3-artifact-save-asset`), which saves the copied bytes from its own origin, as "Save image" already does (`TaskArtifactViewer`). The href is left relative so the ZIP and `file://` copies keep an ordinary link.
- `unplayableMediaReferences` (`src/bun/artifact-media-references.ts`) scans the stored HTML's `audio`/`video`/`source` `src` and `<a href>` for local media-like extensions and refuses the publish, one line per file: not bundled, unsupported format (with an ffmpeg command), or outside the report directory. It runs on the authoritative bun path, skips scripts, styles and comments, and never touches scheme URLs.
- Opus, FLAC, AAC-in-ADTS, AIFF stay out: transport would carry them, but playback depends on the engine. OGG is in because both measured engines decode it; the reference asks for an MP3 fallback `<source>`.

## Risks

- A report that referenced a missing or unsupported clip used to publish with a dead player; it now fails. That is the point, but it is a behavior change for video too.
- Playback of every allowed format is unverified on WebView2 (Windows), WebKitGTK (Linux), mobile Safari and pre-26 macOS WebKit; only WKWebView on macOS 26 and Chromium were measured.
- Any `<a href>` that resolves to a bundled asset — an image or stylesheet too, not only media — now saves the file on click instead of navigating nowhere. That is broader than audio, deliberately.
- The reference scan is regex over markup, like the existing rewrite: a media URL built at runtime is invisible to it and remains the author's job via `dev3Artifact.asset()`.

## Alternatives considered

- **Warn instead of fail.** A CLI warning scrolls past an agent's tool output; the failure mode being fixed is exactly a silent publish.
- **Rewrite `<a href>` to a data URL.** The sandbox blocks the download, and navigation to a `data:` URL is blocked by engines, so the link would still do nothing.
- **Separate audio caps.** Audio and video pay the same per-open data-URL cost, so one shared budget is the honest bound.
