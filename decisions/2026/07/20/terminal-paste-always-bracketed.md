# 145 — Route terminal text paste through one bracketed path

## Context

In remote/browser mode a multi-line `Ctrl+V` submitted after the first line
(reported on Windows, where the clipboard carries `CRLF`). Multi-line text meant
to land in a draft (e.g. Claude Code) was executed line-by-line.

## Investigation

ghostty-web has **two** paste handlers:

- On the textarea (`ghostty-web.js` ~L2368): calls `term.paste()`, which wraps in
  DEC 2004 bracketed paste when the app enabled it.
- On the container / `InputHandler.handlePaste` (~L963): fires `onDataCallback(raw)`
  — the **raw** clipboard bytes, ignoring bracketed-paste mode entirely.

`Terminal.focus()` (~L2446) focuses the **container** (the contenteditable div),
not the textarea. On desktop/remote `TerminalView` calls `term.focus()` after fit
and on every click, so the container holds focus — which routes paste onto the raw
handler. Raw `\r\n`/`\n` then reads as Enter, submitting after the first line.
Confirmed live: with the container focused, the outgoing PTY bytes carried the
raw newlines.

## Decision

`TerminalView`'s own capture-phase `paste` listener (`src/mainview/TerminalView.tsx`,
`onPaste`) now handles ordinary text too: `preventDefault()` +
`stopImmediatePropagation()` (pre-empting both ghostty handlers, since ours is
registered first), then `term.paste(normalizePastedText(text))`.
`normalizePastedText` collapses `CRLF`/`CR`/`LF` to lone `CR` (xterm.js
convention). Image and large-text attachment paths are unchanged.

## Risks

Relies on our listener being registered before ghostty's — guaranteed because
`setup()` (which calls `term.open()`) is deferred behind an async `document.fonts.load()`,
while the `onPaste` effect runs synchronously on mount. If a future refactor makes
setup synchronous, `stopImmediatePropagation()` would no longer pre-empt ghostty's
raw handler.

## Alternatives considered

- Patch ghostty-web's `handlePaste` to bracket — rejected: editing vendored
  `node_modules` is not durable across reinstalls.
- Force focus onto the hidden textarea so the bracketed handler always wins —
  rejected: fragile against the many `term.focus()` / click focus paths, and does
  not fix Electrobun desktop.
