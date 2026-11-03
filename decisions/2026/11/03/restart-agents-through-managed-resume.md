# Restart agents through managed resume

## Context

An agent may need a restart while its terminal still exists, including the shell left after the agent exits. Opening another agent and resuming manually can detach the conversation from the pane metadata that hibernation uses.

## Investigation

`resumeTaskSession` already preserves the agent, preset, account, conversation and launch hooks. Hibernation also stops dev servers and reaps worktree processes, while native extra agent panes have no saved conversation IDs and cannot currently be restored by recovery.

## Decision

Add Restart agent session to the existing task context menu, passing `restart: true` to the existing resume RPC. In `src/bun/rpc-handlers/tmux-pty/resume.ts`, verify the saved conversations before teardown, park their entries against pane-exit reconciliation, wait for terminal teardown and reuse the normal resume launch; the keep-alive scheduler shares this operation and rechecks agent exit inside its lock. A `taskTerminalResumed` event clears stale native pane state and remounts visible terminal canvases because a cleanly closed socket does not reconnect just because its unchanged URL names a new process.

## Risks

Restart replaces the whole task terminal, losing terminal scrollback and closing auxiliary panes; confirmation names those effects. Native tasks with extra panes refuse before teardown, and missing or substituted conversations also refuse. A launch can still fail after teardown, so saved conversations remain recoverable and partial restoration is reported as an error.

## Alternatives considered

Hibernate then wake is smaller mechanically but unnecessarily stops the development environment. Resuming only after a detected agent exit cannot restart a stuck live agent and depends on platform-specific process evidence. Per-pane restart requires new terminal replacement and native conversation-persistence machinery, so it is outside this minimal change.
