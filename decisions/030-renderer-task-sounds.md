# Renderer Task Sounds

## Context

Task completion and cancellation sounds broke in packaged builds because the Bun process expected a normal filesystem path and tried to launch `afplay`. Electrobun packages renderer assets correctly, but Bun-side audio playback kept fighting the bundle format and dragged in cache and fallback logic that did not belong in the backend.

## Investigation

The earlier fallback fixed the missing-path symptom by embedding MP3 bytes into Bun and materializing them under `${DEV3_HOME}/cache/sounds/`. That recovered playback, but it duplicated assets, increased build complexity, and still treated a UI feedback sound as a backend concern.

## Decision

Move task sound playback into the renderer and keep Bun responsible only for emitting `taskSound` RPC messages from `src/bun/rpc-handlers/task-lifecycle.ts` and `src/bun/cli-socket-server.ts`. The React app now preloads `src/assets/sounds/*.mp3` in `src/mainview/task-sounds.ts` and plays them via browser audio when `src/mainview/App.tsx` receives the push event.

## Risks

Browser audio may require at least one user interaction before autoplay policies fully unlock playback, so `task-sounds.ts` keeps a tiny retry queue and installs unlock listeners. If a renderer is not alive, no sound will play, but that matches the feature's role as in-app UI feedback rather than a system-level notification.

## Alternatives considered

Keep `afplay` with packaged fallbacks: rejected because it couples UI sound to Bun, filesystem paths, and cache management. Add special Electrobun resource extraction for sounds: rejected because the renderer already gets asset bundling for free and does not need another packaging workaround.
