# A dev launch opens its window without activating the app

## Context

Starting a dev build (`bun run dev` / the task dev server) yanked the user out of
whatever they were doing: the new window took foreground, and because macOS follows
the frontmost app, a fullscreen app on another Space was swapped away mid-use.
Ordinary launches must keep coming to the front — the user asked for those.

## Investigation

Electrobun's `BrowserWindow` takes an undocumented `activate` option (default `true`)
that reaches `showWindow(ptr, activate)` in the prebuilt `libNativeWrapper.dylib`.
Disassembling that symbol (`objdump --macho -d`, `_showWindow` at `0x308bc`) shows the
whole difference:

- `activate == true` → `orderFront:`, `makeKeyAndOrderFront:`, then
  `[NSApp activateIgnoringOtherApps:YES]` — the foreground steal.
- `activate == false` → `orderFrontRegardless` alone — the window is ordered in
  (visible on its Space even while the app is inactive), the app never activates.

So the lever already exists; nothing needed hiding, delaying, or re-focusing.

## Decision

`createAppWindow` forwards an `activate` option to the constructor (`window-manager.ts`),
and `src/bun/index.ts` passes `shouldActivateLaunchWindow()` (`fresh-start.ts`) for the
windows a LAUNCH opens. That helper is `!isFreshStartMode()` — `DEV3_FRESH_START=1`, the
marker the dev scripts already set, is the authoritative "this is a dev launch" signal.
Windows opened later (Cmd+Shift+N, a notification click, `dev3 ui focus`) are untouched
and still activate.

Measured on macOS 15 (Darwin 24.6.0), user sitting in a fullscreen app: before the fix the
dev app became frontmost within ~10s of launch; after it, 61/61 frontmost samples stayed on
the user's app, and the dev window sat fully rendered on ordinary Space 3 while the active
Space stayed the fullscreen one (`CGSCopySpacesForWindows` / `CGSGetActiveSpace`).

## Risks

The dev window opens behind whatever is in front, so on a normal Space it appears without
focus — intended, but it is a behaviour change for anyone used to the build ending with the
app in their face. If a future electrobun bump changes what `activate: false` maps to, the
window could stop being ordered in at all; the guard is the pair of tests in
`window-manager-fresh.test.ts`, which only prove the flag is passed, not what the native
side does with it.

## Alternatives considered

- Activate and then hide/re-focus the previous app — a visible flicker and a race with the
  user; explicitly ruled out.
- Gate on the `dev` build channel instead of fresh-start — wrong axis: a dev-channel build
  the user double-clicks in Finder must come to the front.
- Patch the launcher (`open -g`) — `electrobun dev` spawns the bundle's `launcher` binary
  directly, never through `open`, so there is no such flag to pass.
