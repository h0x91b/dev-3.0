# Bundled Task Sound Fallback

## Context

Task completion and cancellation sounds worked in dev, but packaged macOS builds logged `Task complete sound file not found` and played nothing. Electrobun 1.14+ stores bundled resources inside a tar archive, so `existsSync(PATHS.VIEWS_FOLDER/../sounds/*.mp3)` is not a reliable production check.

## Investigation

The app logs on April 6, 2026 showed repeated lookups for `/Applications/dev-3.0.app/Contents/Resources/app/sounds/task-completed.mp3`, while the actual `.app` bundle only exposed a tarball in `Contents/Resources/`. This matched the existing changelog fallback pattern, where filesystem access had already been replaced by build-time inlined data.

## Decision

Generate `src/bun/sound-bundled.ts` from `src/assets/sounds/*.mp3` at build time and use it as a fallback in `src/bun/rpc-handlers/task-lifecycle.ts` (`playTaskCompleteSound()`). The Bun handler now materializes the embedded audio into `${DEV3_HOME}/cache/sounds/` and then launches `afplay` against that cache file when packaged asset paths are inaccessible.

## Risks

The embedded base64 increases the Bun bundle size slightly and requires regeneration when bundled sounds change. If the cache write fails or the user lacks a working `afplay`, the sound still will not play, but the failure mode is now explicit and no longer depends on fragile bundle paths.

## Alternatives considered

Keep reading directly from `PATHS.VIEWS_FOLDER`: rejected because packaged resources are not regular files in current Electrobun builds. Move sound playback into the renderer via `views://`: rejected because the status transition is owned by the Bun process and already has a synchronous native `afplay` path that is simpler once the asset is materialized locally.
