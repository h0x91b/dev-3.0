# 146 — Insecure-context clipboard fallback + stale tmux bindings need explicit pins

## Context

After the #991 revert shipped (#1013), a user reported terminal copy "stopped working" in Chrome remote mode. Live logs showed two independent facts: (1) the renderer logged `navigator.clipboard.writeText unavailable` — the session ran over plain http (`ip: direct`), where browsers hide the async clipboard API entirely, while the pre-restart session went through the https tunnel and wrote the clipboard fine; (2) the running tmux server (started days earlier) still had the reverted `copy-selection` bindings — deleting a `bind` line from the config does not unbind anything on a live server, so the revert was inert there.

## Investigation

Reproduced the insecure context in headless Chromium via `http://127.0.0.1.nip.io` (a hostname resolving to 127.0.0.1 is not a trustworthy origin, unlike literal `localhost`): `navigator.clipboard` is undefined, and `document.execCommand("copy")` succeeds at +300ms and +2s after a mouse gesture but fails at +7s — Chromium's ~5s transient activation window. OSC 52 payloads arrive a few hundred ms after the copy mouseup, comfortably inside it.

## Decision

Two fixes. [`writeClipboardText`](../src/mainview/utils/clipboard-write.ts) tries `navigator.clipboard.writeText` and falls back to a hidden-textarea `execCommand("copy")`; the OSC 52 handler in [`TerminalView`](../src/mainview/TerminalView.tsx) uses it and logs the method honestly instead of `.catch(() => {})`. [`TMUX_CONFIG_FUNCTIONAL`](../src/bun/tmux/config.ts) now explicitly binds `MouseDragEnd1Pane` to the default `copy-pipe-and-cancel` in both copy-mode tables, so `configureTmux`'s config re-source overrides the stale binding on running servers.

## Risks

`execCommand` is deprecated but universally supported; it fails outside transient activation, which the result logging makes visible. The explicit default pin overrides any user-side rebinding of `MouseDragEnd1Pane` in their own tmux config sourced earlier.

## Alternatives considered

Queueing the payload and flushing on the next user gesture — deferred; adds a copy-is-one-gesture-late UX and the transient-activation window already covers the real flow. Forcing the tunnel URL for remote — doesn't help LAN-only setups and leaves the silent failure in place. `unbind` commands in the config — messier than an explicit pin and equally required on every re-source.
