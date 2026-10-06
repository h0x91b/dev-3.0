# Register the Window menu as NSApp.windowsMenu via a native shim

## Context

A user report (Ofer Belinsky) showed dev3's macOS Window menu with only Minimize, Zoom, Bring All To Front, Cycle Through Windows and Close, while other apps get Fill, Center, Move & Resize, Full Screen Tile, "Move to <display>" and a window list. AppKit adds those items only to the menu registered as `NSApp.windowsMenu`.

## Investigation

Electrobun's `setApplicationMenu` (`package/src/native/macos/nativeWrapper.mm`, v1.18.1 and v2.0.3-beta.9) builds the menu in a `dispatch_async` main-queue block and calls `setMainMenu:` only — `setWindowsMenu:` appears nowhere, and the shipped `libNativeWrapper.dylib` has no such selector string. Reading the closed menu through System Events afterwards matched Slack's item for item; "Move to <display>" rows are filled in by AppKit only when the menu opens, and only with more than one display.

## Decision

`src/native/macos/dev3-window-menu.m` (built into `dist/native/dev3-window-menu.dylib` by `scripts/build-native-macos.sh`, renamed from `build-native-notifications.sh`) exports `dev3_window_menu_adopt()`. It queues a main-queue block that finds the submenu holding the `performMiniaturize:` item and sets it as `NSApp.windowsMenu`. FIFO main-queue order puts it after Electrobun's menu build. `src/bun/native-window-menu.ts` loads it lazily and is a no-op off macOS, in headless mode, or without the dylib. `installApplicationMenu` in `src/bun/index.ts` calls it after every menu rebuild, because each rebuild creates a fresh `NSMenu`. No custom items are added: the OS decides which ones appear, based on its version and the connected displays.

## Risks

- Relies on Electrobun keeping `dispatch_async` for `setApplicationMenu`. If it turns synchronous the ordering still holds. If it moves off the main queue, the shim could see the previous menu until the next rebuild.
- If upstream starts setting `windowsMenu` itself, the shim becomes redundant (harmless, since it skips an already-registered menu) and should be deleted.

## Alternatives considered

- **Pure bun:ffi + libobjc** — the Bun JS runs on a worker thread, so AppKit cannot be touched safely and the new menu does not exist yet when the call returns.
- **Patch/fork Electrobun's native wrapper** — needs their zig build chain and a vendored dylib for a one-line fix. The shim is additive and survives Electrobun bumps.
- **Own Move-to-display/tiling items** — duplicates OS logic, gets display names and OS gating wrong, and diverges from every other Mac app.
