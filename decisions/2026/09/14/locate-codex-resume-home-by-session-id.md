# Locate the Codex resume home by session ID

## Context

Preserving accounts on new launches does not repair existing tasks whose session IDs were saved without account metadata. The user requested discovery across all local account stores so those conversations can be restored directly.

## Investigation

A read-only run of the new scanner found both reported task conversations in the same original managed home, in 61 and 18 milliseconds. Files use a rollout filename ending in the UUID and a first `session_meta` record containing that UUID; no auth or conversation body parsing is needed.

## Decision

`resolveCodexResumeHome` in `src/bun/codex-resume-home.ts` scans the system home, managed account directories and supplied custom homes for the exact ID, verifies its bounded header and returns its home. `resumeTask` in `src/bun/rpc-handlers/tmux-pty.ts` resolves all known Codex IDs before waking or tearing down terminals, forces each found CODEX_HOME and persists the associated account. Both main-pane state writes preserve extra panes for subsequent recovery, clearing stale tmux IDs before the new panes start. The existing terminal toast service displays the exact resume error.

## Risks

An unreadable store blocks discovery rather than pretending the scan was complete; ambiguous or archived-only matches also require explicit resolution. Account credentials may still be absent or expired: the exact home is retained and Codex reports that error, without falling back to another login. A Codex pane without a saved ID also fails explicitly, because latest-session fallback could select a different conversation. Custom homes must remain configured to be discoverable.

## Alternatives considered

Using the current default account reproduces the incident; searching by cwd or selecting the newest transcript risks replacing the intended conversation. Copying sessions between accounts changes shared user state and was rejected. Selecting the exact home at launch needs no on-disk schema migration and keeps the existing session ID unchanged.
