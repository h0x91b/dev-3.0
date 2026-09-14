# Preserve Codex resume account pairing

Superseded on 2026-09-14 by `decisions/2026/09/14/locate-codex-resume-home-by-session-id.md`: exact-ID lookup now also repairs legacy missing account pairings.

## Context

A post-reboot resume passed an intact Codex session ID to a different managed CODEX_HOME. Backups contained the ID but no task or pane account, so the current default selected a different session store; a later extra pane recovered through its explicit original account.

## Investigation

The saved ID existed only in the original managed home, with a matching worktree header and a creation time two days before reboot. `launchTaskPty` persisted the requested account rather than the resolved default; it also used the task account on main-pane resume even when that pane had its own account.

## Decision

`codexAccountIdForHome` in `src/bun/agent-accounts.ts` maps an exact registered home to its existing account ID without reading credentials. Fresh main-pane Codex launches snapshot that resolved account; `resumeTask` and `launchTaskPty` in `src/bun/rpc-handlers/tmux-pty.ts` prefer the saved pane account, preserving explicit null and falling back to the task only for undefined.

## Risks

Legacy sessions lacking account metadata still need explicit recovery; an unverified resume must not bless today's default as the session's owner. Custom homes, removed credentials/accounts, extra-pane persistence and other launch paths retain their existing behavior. Only the existing accountId field is written; no store is moved, copied or migrated.

## Alternatives considered

Searching every account for a saved session or silently using the newest conversation would widen routing behavior and risk context substitution. Changing the user's default or combining account stores would affect unrelated sessions. Those approaches were rejected in favor of preserving the account at launch and honoring it at resume.
