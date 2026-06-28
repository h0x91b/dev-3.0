# 084 — Transport-aware keymap for browser remote mode

## Context

The renderer is served both to the Electrobun desktop shell and to a plain browser (`dev3 remote`). Most app shortcuts are renderer `keydown` handlers (`App.tsx`), so they run in both. But the browser claims several combos (⌘1–9 = tab switch, ⌘N = new window, native zoom, reload — some not cancelable), the native menu bar (a discoverability + command surface) is absent, and shell-level shortcuts (⌘Q/⌘H/New Window) would act on the browser, not the app.

## Decision

Made the keymap transport-aware off `isRemote()` (`utils/platform.ts`, absence of `window.__electrobunWebviewId` — mirrors `isElectrobun` in `rpc.ts`). `keymap.ts` gained `scope` (`both`|`desktop`|`remote`) and `remoteKeys`, plus `appShortcutsForMode`/`shortcutKeysForMode`/`shortcutAppliesInMode`. In remote: `App.tsx` bails the drop-fated branches BEFORE `preventDefault` (⌘Q/⌘H/⇧⌘N/zoom/⌘1–9/⌘N) so the browser keeps its native behavior; aliases (`G then 1–9`, `C`) cover the lost combos. `KeyboardShortcutsModal` hides `scope:"desktop"` rows, renders `remoteKeys`, and shows a notice. `commands.ts` hides `task-open-in-finder` in remote (it opens Finder on the server host). Git/task/project actions stay reachable via the inspector (`TaskGitActions.tsx`) and palette; tmux pane ops via the `⌃B` prefix.

## Risks

`preventDefault` reliability varies by browser; only combos we can realistically own are kept — the rest are aliased or yielded, never falsely promised. `keymap.ts` must stay in lockstep with the `App.tsx` handlers (existing manual discipline).

## Tests

`isRemote()` keys off the same flag as the rpc transport, so faking it globally in test-setup flips `rpc.ts` into the Electrobun bridge path, which throws at import in real-rpc test files. Therefore happy-dom defaults to remote; desktop-keymap tests (App.test.tsx, KeyboardShortcutsModal.test.tsx) set `__electrobunWebviewId` locally and mock rpc.

## Alternatives considered

Command-palette-only (no keymap change) — abandons muscle memory and leaves the Finder command misleading; adopted only as the fallback layer. Full remote remap of every conflicting combo — creates a divergent map users must relearn. Leader-key mode — powerful but unfamiliar and heavy. Plan: `docs/ux/feature-plans/remote-hotkey-mapping.md`.
