# 045 — OSC 52 clipboard write must stay server-side on desktop

## Context

Three users reported that selecting text with the mouse in the embedded tmux
terminal stopped landing in the system clipboard. The regression was
bisected to PR #473 (commit `33b6af9a`, 16 Apr 2026 — *Fix OSC 52 clipboard
forwarding*), which:

1. Removed the explicit tmux bindings
   `bind -T copy-mode{,-vi} MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "pbcopy"`.
2. Replaced the server-side `spawn(["pbcopy"])` call inside `handleOsc52`
   with an IPC forward to the renderer, which then invoked
   `navigator.clipboard.writeText(text).catch(() => {})`.

## Investigation

`navigator.clipboard.writeText()` in Electrobun's WKWebView requires
[transient activation](https://www.w3.org/TR/clipboard-apis/#dom-clipboard-writetext)
— a fresh user gesture. An asynchronous WebSocket message handler does
**not** carry that activation, so the call rejects with `NotAllowedError`.
The `.catch(() => {})` swallowed the rejection, and the diagnostics added
in PR #499 confirmed the call was hitting that exact path.

`tmux set -s set-clipboard on` (still present in the config) does cause tmux
to emit OSC 52 sequences when copying to its buffer, so the data was reaching
`handleOsc52`; the failure was strictly on the renderer side.

## Decision

Restore server-side clipboard writes on the desktop main process, while
keeping the renderer/browser forward path for remote-access browser clients.

- New helper `src/bun/system-clipboard.ts` → `writeSystemClipboard(text)`
  picks the right host tool: `pbcopy` on macOS, `wl-copy` under Wayland on
  Linux, `xclip -selection clipboard` on X11. The resolved tool is cached.
- The desktop entry-point callback (`src/bun/index.ts`) calls
  `writeSystemClipboard()` first, then still forwards via webview RPC and
  `pushToBrowserClients()` for diagnostics + remote browser users.
- The headless entry-point (`src/bun/headless-entry.ts`) is unchanged: it
  only forwards, because the user is the remote browser, not the host.

## Risks

- Linux desktops without `wl-copy` or `xclip` get `null` from the helper and
  no clipboard write — this matches pre-#473 behaviour for those hosts.
- If `pbcopy` is missing from PATH inside an `.app` bundle, the helper falls
  back to bare `"pbcopy"`; macOS always ships it under `/usr/bin/pbcopy`.
- Remote-browser clipboard write is still subject to the same gesture
  restriction. That's a separate, smaller user population and out of scope
  here; the diagnostics added in PR #499 are kept to track it.

## Alternatives considered

- **Re-add the tmux `MouseDragEnd1Pane copy-pipe-and-cancel "pbcopy"`
  bindings.** Rejected: hard-codes `pbcopy`, breaks on Linux, and is
  redundant once OSC 52 is handled server-side.
- **Only forward to the renderer and try to grab a user gesture there**
  (e.g. on `mouseup`). Rejected: complex, still flaky on Electrobun, and
  doesn't cover the inner-app OSC 52 cases (vim `"+y`, claude code copy).
- **Block the WS message until a synthetic user gesture fires.** Rejected:
  there is no reliable cross-process gesture forwarding in Electrobun.
