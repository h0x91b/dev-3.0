# 035 — Lazy quick-switch hydration to avoid Electrobun startup bridge race

## Context

`Tasks Quick Switch` originally fetched global settings and all project tasks during `App` mount. In Electrobun this occasionally triggered a Bun-to-webview push before `window.__electrobun.receiveMessageFromBun` existed, which crashed startup with a renderer `TypeError`.

## Investigation

The crash string matched Electrobun internals that dispatch Bun messages through `window.__electrobun.receiveMessageFromBun(...)`. Comparing the pre-feature and post-feature `App.tsx` showed the new eager quick-switch RPCs were the only startup behavior change touching the bridge that early.

## Decision

In [src/mainview/App.tsx](../src/mainview/App.tsx), remove the quick-switch startup RPCs and hydrate the switcher lazily on the first quick-switch shortcut invocation. Cache the loaded settings/task map in React state, keep live updates flowing through the existing `dev3:globalSettingsChanged` and `rpc:taskUpdated` events, and persist the full recorded shortcut in localStorage via [src/mainview/components/global-settings/utils.ts](../src/mainview/components/global-settings/utils.ts) so the first post-restart keypress still uses the configured hotkey.

## Risks

The first quick-switch invocation now does a small async fetch before the modal opens, so the very first use can be slightly slower than later uses. The shortcut is duplicated in both backend settings and localStorage, so they must stay in sync; if the lazy fetch fails, the switcher still falls back to the locally persisted shortcut and retries settings/task hydration on a later invocation.

## Alternatives considered

Keeping the eager startup fetches was rejected because they reproduced the startup crash. Patching Electrobun internals directly was rejected because the bug sits in a vendored dependency path and the app can avoid the race with a smaller renderer-side change.
