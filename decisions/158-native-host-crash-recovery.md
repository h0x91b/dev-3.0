# 158 — Deterministic native host-crash recovery

## Context

The isolated native-session registry could stop an owned tree normally, but had
no direct proof for a host killed before shutdown code ran. Seq 1236 requires
that proof without selecting the native backend in production or touching tmux.

## Investigation

On Windows the detached host is both a member of and the sole long-lived handle
owner for its token-named kill-on-close Job Object, so force-terminating only the
host closes the final handle. On POSIX, a Bun.Terminal host owns the PTY master;
an abrupt host exit closes it and hangs up the attached interactive shell tree.

## Decision

The [`run()` crash proof](../src/bun/native-terminal-registry/__tests__/crash-recovery.bun-e2e.ts)
force-kills the recorded host during journal/parser activity and proves bounded
owned-tree death while external sentinels survive. Windows relies on Job Object
kill-on-close; POSIX relies on PTY hangup for the terminal-owned tree, preserving
platform-native primitives rather than inventing one process abstraction.

[`JournalWriter.flush()`](../src/bun/native-terminal-registry/journal.ts) and
[`writeParserStateAtomic()`](../src/bun/native-terminal-registry/parser-state.ts)
publish complete snapshots by temp-file rename, while `readParserState()` rejects
malformed nested state. [`cleanupStale()` and `start()`](../src/bun/native-terminal-registry/registry.ts)
share the per-session lock, so exact-token removal cannot erase a concurrent
same-ID replacement; list/status expose the dead record until cleanup succeeds.

## Risks

The POSIX guarantee does not include deliberately daemonized descendants that
detach from the terminal or ignore SIGHUP; adopting or scanning such processes
would violate this ticket's ownership boundary. Windows evidence depends on Bun
1.3.14 plus native Job Object semantics, so the pinned CI and PowerShell proof
must remain a release gate while this module is experimental.

## Alternatives considered

Calling registry `stop` after the host kill was rejected because it would not
prove kill-on-close. Cross-platform PID walks, `taskkill /T`, process adoption,
and automatic resurrection were rejected because each widens ownership or hides
the crash instead of testing the platform containment already in place.
