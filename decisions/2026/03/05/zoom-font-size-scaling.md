# 012 — Zoom via root font-size scaling

## Context

GitHub issue #52 requested zoom in/out support. The app runs inside Electrobun (WKWebView), which does not expose a native `pageZoom` API.

## Investigation

Three approaches were evaluated:

1. **CSS `zoom` property** — WKWebView renders text blurry at non-1.0 zoom values (bitmap scaling).
2. **`transform: scale()`** — Same blurriness issue, plus layout complications (element dimensions don't change, overflow handling breaks).
3. **Root font-size scaling** — Change `document.documentElement.style.fontSize`. The browser re-renders text natively at the new size. Combined with rem-based layout (Tailwind defaults), all UI elements scale proportionally with crisp text.

## Decision

Chose root font-size scaling (option 3). Implementation in `src/mainview/zoom.ts`:

- `applyZoom(level)` sets `fontSize = 16 * level` px on `<html>`, persists to localStorage, dispatches `zoom-changed` event.
- `bootstrapZoom()` called before React mount to restore saved zoom without dispatching events.
- All hardcoded `px` values in Tailwind arbitrary classes converted to `rem` so they scale with the root font-size.
- Terminal (ghostty-web canvas) doesn't respond to CSS font-size — handled separately by setting `term.options.fontSize` and calling `fitAddon.fit()`.

Keyboard shortcuts: Cmd+= (zoom in), Cmd+- (zoom out), Cmd+0 (reset). Also accessible via View menu and Settings UI.

## Risks

- Any new hardcoded `px` values in Tailwind arbitrary classes won't scale with zoom. Developers must use `rem` for structural dimensions.
- Terminal font size is managed independently — any new terminal creation paths must read `getZoom()` at construction time.

## Alternatives considered

- **Electrobun native zoom API** — doesn't exist yet. If added in the future, could replace this approach.
- **Per-component scaling** — too much maintenance overhead, easy to miss elements.
