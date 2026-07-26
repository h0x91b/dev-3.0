# 172 — Probe the running tmux server version

## Context

After an app update, a tmux server can remain alive with sessions created by an older binary while dev3 selects the newly bundled client. In that state task launches can fail with `open terminal failed: not a terminal`, although non-interactive tmux commands still work.
This supersedes the live-server probe assumption in decisions 105 and 137, while retaining their binary pinning and fallback strategy.

## Investigation

The incident log contained four launches whose PTY emitted exactly 38 bytes before exiting, matching `open terminal failed: not a terminal\r\n`.
tmux issue #4356 documents that protocol version skew can preserve commands such as `list-sessions` while losing the terminal file descriptor required by an attached `new-session`; killing every session works because it also stops the old server.

## Decision

`selectTmuxBinary` compares the live server's `display-message -p '#{version}'` result with each candidate's `tmux -V`, instead of treating a successful `list-sessions` as compatibility. Startup scans every tmux candidate on `PATH`, including binaries after the dev3 shim, and falls back to an exact-version client when possible; otherwise task launch reports the existing tmux Sessions → Kill All recovery.

## Risks

Exact version matching is intentionally conservative: two different versions that happen to interoperate will not be mixed. If the server version cannot be read, the generic launch diagnostic remains the fallback rather than claiming a confirmed version mismatch.

## Alternatives considered

Automatically killing the server would destroy every live terminal and is not acceptable. Retrying `new-session`, raising the wait timeout, or probing only `list-sessions` cannot restore the missing terminal file descriptor and would hide the actual recovery.
