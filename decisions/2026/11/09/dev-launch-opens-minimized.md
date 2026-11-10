# A dev launch opens its window minimized

## Context

`decisions/2026/09/11/dev-launch-opens-without-activating.md` stopped the dev window from
taking foreground, but `activate: false` still orders the window in with
`orderFrontRegardless`. On a normal Space the dev window landed on top of the app the
user was working in. The user wants a dev launch to stay out of sight until they ask for it.

## Investigation

Measured on macOS 26 (Darwin 27.2.0): with the old behaviour the frontmost app stayed the
user's, but the window was on screen. Electrobun's `BrowserWindow` takes a `hidden` option
and has `minimize()` (`miniaturize:`). Created hidden, then minimized, the window goes to the
Dock without ever showing; the frontmost app stayed the user's for every sample, `dom-ready`
still fired, and the window rendered fully when restored from the Dock.

## Decision

`createAppWindow` takes `background` (`window-manager.ts`) instead of `activate`: it passes
`activate: false` and `hidden: true` to the constructor, then calls `win.minimize()`.
`src/bun/index.ts` passes `shouldOpenLaunchWindowInBackground()` (`fresh-start.ts`,
`DEV3_FRESH_START=1`) for launch windows only, and skips re-focusing the primary window
for a background launch. Windows opened later still come to the front.

## Risks

A dev launch now ends with nothing visible: the user opens it from the Dock. The first-paint
resize nudge runs while the window is minimized; the restore check above showed no blank
paint, but it is not covered by an automated test.

## Alternatives considered

- Keep the window visible behind the active app (`orderBack:`) - electrobun exposes no such
  call, and a visible window still covers anything behind the active app.
- Create the window visible and minimize it - flashes on screen first.
