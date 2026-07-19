# 139 — Preserve the terminal viewport across streamed writes

## Context

`ghostty-web` 0.4.0 unconditionally calls `scrollToBottom()` from `writeInternal()`, so any streamed PTY output pulls a user out of scrollback. Selection invalidation is a separate existing behavior and must remain unchanged.

## Investigation

Upstream [issue #127](https://github.com/coder/ghostty-web/issues/127) and [PR #150](https://github.com/coder/ghostty-web/pull/150) identify the same forced-scroll behavior. [towles-tool-rs PR #65](https://github.com/ChrisTowles/towles-tool-rs/pull/65) confirms that restoring the viewport by the scrollback-length delta fixes it in a consumer application.

## Decision

Route batched PTY output in `TerminalView` through `writePreservingViewport()`. When the viewport is above the live bottom, the helper captures the viewport and scrollback length, writes the data, restores the viewport with the scrollback delta, and synchronizes Ghostty's smooth-scroll target when that private field is present.

## Risks

The smooth-scroll target is an undocumented Ghostty field and may disappear, but the public `scrollToLine()` restoration remains functional without it. Remove the workaround once an upstream release includes the fix, using the regression tests to verify equivalent behavior.

## Alternatives considered

A VS Code renderer flag or Codex alternate-screen flag does not affect Ghostty's forced scroll. Disabling smooth scrolling changes interaction feel, and monkey-patching `writeInternal()` couples the whole terminal instance to a private method, so both were rejected in favor of the narrow PTY-write wrapper.
