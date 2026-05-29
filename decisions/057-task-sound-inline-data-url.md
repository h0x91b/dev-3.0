# Task Sounds Inlined as data: URLs

## Context

Task completion/cancellation sounds stopped playing in packaged builds. Console showed `[task-sounds] playback failed — NotSupportedError: The operation is not supported.` and `Failed to load resource: Resource not found`.

## Investigation

The DevTools Network tab showed the `<audio>` element (AppleCoreMedia user agent) requesting `views://mainview/assets/task-completed-*.mp3` with `Range: bytes=0-1` and getting an empty response (no headers, no status). WKWebView's media loader always fetches media with Range requests, but the Electrobun `views://` scheme handler does not satisfy them — so the MP3 never loads. This contradicts decision 030's assumption that the renderer gets working asset bundling "for free". Likely surfaced by the Electrobun 1.14.4 → 1.18.1 bump (#549), which changed scheme-handler behavior; not verified by version rollback.

## Decision

Import the MP3s with Vite's `?inline` suffix (`src/mainview/task-sounds.ts`) so they are emitted as base64 `data:` URLs embedded in the JS bundle instead of files served via `views://`. A `data:` URL is loaded directly by the media element with no scheme handler and no Range request, so playback works in packaged builds on every OS. Regression guard in `src/mainview/__tests__/task-sounds.test.ts` asserts the URLs start with `data:audio/`.

## Risks

The two MP3s (~67 KB) are base64-inlined into the main JS chunk (~+90 KB raw). Negligible for a desktop app. Any future audio asset must also use `?inline` or it will silently break the same way.

## Alternatives considered

Raise `build.assetsInlineLimit`: rejected — would inline unrelated assets globally. Revert to native `afplay` on the Bun side: rejected — macOS-only, breaks Linux support (see decision 030). Patch the `views://` handler for Range: rejected — it is Electrobun-internal and out of our control.
