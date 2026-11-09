# Re-register a forgotten PTY session once, then treat the refusal as final

## Context

After a server restart (`systemctl restart dev3-remote`, a reinstall) the new PTY server has an empty session map. Sessions are registered only by `getPtyUrl` / `getProjectPtyUrl`, so an open page's reconnect is refused with `4001 Unknown session` although tmux still runs the session. The remote proxy (`proxyToPty` in `src/bun/remote-access-server.ts`) closed the browser socket with a bare `close()`, which turned that refusal into `1000`, and `TerminalView` printed `[session ended]`.

## Decision

`downstreamPtyClose` forwards the upstream code (1000 and 3000-4999 verbatim, anything else as retryable `4003`). `TerminalView` gets an `onSessionUnknown` callback: on `4001` after output has arrived since the last re-registration, it asks the owner to call the registering RPC again and reconnects once. `TaskTerminal` (tmux) and `ProjectTerminal` supply it; a task whose session is gone gets the recoverable screen.

## Risks

`4001` stays final for a session that never streamed, so the Windows retry loop that `src/shared/pty-ws-close-codes.ts` exists to stop cannot come back. Native panes and the account-login terminal do not pass the callback and keep their old behavior. Re-registering goes through the same RPC as opening the view, so when tmux died with the server it starts a fresh project shell, or a fresh agent for a task with no saved panes, without the user asking.

## Alternatives considered

Registering sessions lazily on WS open in the PTY server: the session needs cwd, env and the tmux command, which only the RPC path knows. Treating every `4001` as retryable: reintroduces the reconnect-forever loop.
