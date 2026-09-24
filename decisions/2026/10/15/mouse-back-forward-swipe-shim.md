# Mouse Back/Forward via a compiled swipe-monitor shim

## Context

The renderer already maps mouse buttons 3/4 to route history (`App.tsx`, PR #680), yet an MX Master under Logi Options+ did nothing in dev3 while working in browsers.

## Investigation

A native probe window logged what the mouse sends: Logi Options+ "Back"/"Forward" arrive as `NSEventTypeSwipe` (`deltaX = +1` / `-1`), not as `otherMouseDown` with button 3/4. WKWebView never turns a swipe into a DOM event, so no renderer code can see it; browsers handle `-swipeWithEvent:` natively. Real buttons 3/4 were verified separately: current WebKit reports them correctly (older WebKit reported every extra button as "middle").

## Decision

`src/native/macos/dev3-mouse-nav.m` installs an app-local `NSEvent` monitor for swipes on the main queue and calls a threadsafe `JSCallback` with +1 (Back) / -1 (Forward); the event passes through. `src/bun/native-mouse-nav.ts` loads it and `index.ts` routes the direction as the renderer's existing `go-back` / `go-forward` menu actions to the focused window. `scripts/build-native-macos.sh` builds it next to the other macOS shims.

## Risks

A three-finger trackpad swipe (when "Swipe between pages" uses three fingers) now also navigates — the same as in a browser. Direction follows the browser convention (`deltaX > 0` = Back); if a driver inverts it, the fix is in `swipeDirectionToAction`. A missing dylib only disables the swipe path.

## Alternatives considered

Pure `bun:ffi` + libobjc swizzling of `-swipeWithEvent:` on WKWebView — avoids a compiled file but fights WebKit's responder chain and is harder to reason about than a documented `NSEvent` monitor. Asking users to remap the buttons to ⌘[ / ⌘] — shifts the fix to every user.
