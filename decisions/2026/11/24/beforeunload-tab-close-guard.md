# Ask before the remote browser tab closes; fullscreen by default on desktop Chromium

## Context

A Windows user in a shell pressed Ctrl+W for "delete word" and the browser closed the dev3 tab. A
page cannot cancel Ctrl+W/⌘W in a normal tab. AGENTS.md bans native dialogs (`window.confirm` and
friends) for app flows, so the guard needs its own justification.

## Decision

Two layers, both browser remote mode only:

1. **Safety net** — `tab-close-guard.ts` registers a `beforeunload` handler (`preventDefault` +
   `returnValue`), so the browser shows its own "Leave site?" prompt. This is the one sanctioned
   browser-native confirmation: it is the browser's own close guard, not an app dialog — no other API
   can intercept a tab close, and it is never used to ask an app question. Never installed under
   Electrobun (it would block quit and reload). Every deliberate reload goes through `reloadPage()`,
   which sets a bypass that is never reset, because the page is going away and some browsers dispatch
   `beforeunload` after `reload()` returns. Setting `remoteConfirmTabClose`, default on.
2. **Prevention** — on desktop Chromium, `fullscreen.ts` reuses the mobile first-click engage, so
   Keyboard Lock (`keyboard-lock.ts`) hands Ctrl+W to the page and the terminal receives ^W.
   Re-arms after a denied request (which fires no `fullscreenchange`); a user's own exit (Esc, the
   menu toggle, F11) disarms it until reload or until the setting is switched back on, so a user
   can stay windowed. Phones keep re-arming after every exit. Setting `remoteAutoFullscreen`, default on. Not engaged on Safari or
   Firefox: no Keyboard Lock, so fullscreen would only hide browser chrome. The browser menu bar
   maps the native `toggleFullScreen` role to a "Toggle Full Screen" item (desktop browsers had no
   way in before). `Escape` is now locked only while a terminal has focus or an Esc-closable layer
   is open (`escape-claims.ts`, fed by `useEscapeKey` and `registerOverlayLayer`), so vim and open
   dialogs get Esc instead of the browser using it to leave fullscreen. In those states leaving
   fullscreen is Chrome's press-and-hold Esc, which it announces itself.

## Risks

Chrome shows the prompt only after a user interaction on the page, and its text cannot be changed.
A first click anywhere throws the page into fullscreen, which some users will find abrupt; the
setting row itself is exempt (`data-no-auto-fullscreen`) so turning it off does not trigger it.
Auto-engage makes the whole `LOCKED_CODES` set (Ctrl+T/N/L/R, Ctrl+Tab, F5, F12, digits, zoom)
the page's for every desktop Chromium remote user by default, not only for users who chose
fullscreen; devtools stays on ⌥⌘I / Ctrl+Shift+I. F11 browser fullscreen does not activate Keyboard Lock — only the element fullscreen dev3 requests.

## Alternatives considered

Intercepting Ctrl+W in `keydown` (impossible outside Keyboard Lock). An in-app React confirm
(cannot run during unload). Locking `Escape` always (makes leaving fullscreen a hidden gesture
everywhere, not just in a terminal). A PWA window, which owns its shortcuts (ruled out in
`fullscreen.ts`: the origin changes per launch).
