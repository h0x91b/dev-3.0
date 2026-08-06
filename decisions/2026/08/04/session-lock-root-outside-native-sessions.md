# 203 — Session-state locks live in their own root, not in `native-sessions`

## Context

Publication of a session's owned state (token, record, capture artifacts) and its
cleanup must be mutually exclusive across processes. A lock inside the session
directory keeps that directory alive through the teardown it is guarding, and a
lock file in `~/.dev3.0/native-sessions/` is enumerated as a session by every
reader of that root — including released versions. Both were tried and both broke.

## Investigation

`native-sessions` enumerators list entries and treat each as a session id, so any
non-session entry becomes a phantom session in `list`, `doctor`, recovery and the
soak harness. Putting the lock inside `<session>/` instead made `removeSessionState`
unable to remove the directory it had just emptied. The repo's existing
`withFileLock` was also considered and rejected: its shipped empty-directory ABI
carries no generation identity, and hardening it in place would change a lock other
running versions already use.

## Decision

Session-state locks live under a NEW top-level sibling, `~/.dev3.0/native-session-locks/`,
overridable with `DEV3_NATIVE_SESSION_LOCKS_DIR`. When only `DEV3_NATIVE_SESSIONS_DIR`
is overridden, the locks root is derived beside it (`<sessionsOverride>-locks`) so an
isolated run cannot write lock state into a real profile. All three family members —
`<id>.canonical.lock`, `<id>.candidate.<generation>.lock`, `<id>.claim.<generation>.lock` —
are flat siblings under that root, with session ids validated before any join.
Lock ordering is coordinator-record lock, then session-state lock, never the reverse;
the host takes only the session-state lock, and nothing inside it acquires another.

## Risks

This is layout-compatible but it does **not** provide mutual exclusion against an
older binary: a released version knows nothing of this protocol, so it will neither
take nor respect these locks. Concurrency safety therefore holds only among versions
that implement it. The root is permanent and nothing is migrated into it; an orphaned
lock file left by a killed process is removed only on definitive dead-or-reused
process evidence, never on age alone, so a wedged file is possible in exchange for
never stealing a live holder's lock. Nothing under `native-sessions` moves, is
renamed, or is deleted.

## Alternatives considered

A lock inside the session directory defeats teardown of that directory. A lock file
in the sessions root is read as a phantom session by every enumerator, including
frozen N-2 readers. A hidden dotfile in either place has the same two problems and
merely hides them from `ls`. One global lock across all sessions serialises unrelated
panes. Reusing the coordinator record lock inverts the required ordering and couples
per-session publication to layout changes.
