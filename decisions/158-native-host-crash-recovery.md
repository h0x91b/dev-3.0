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

`crash-recovery.bun-e2e.ts` force-kills the recorded host during journal/parser
activity and proves bounded host, shell, child, and grandchild death while two
external sentinels survive. Windows relies on Job Object kill-on-close; POSIX
relies on PTY hangup for the terminal-owned tree, preserving platform-native
primitives rather than inventing one portable process abstraction.

Registry, token, journal, and parser snapshots publish by temp-file rename, and
parser reads validate their full structure. `cleanup-stale` removes exact-token
state plus only the recorded host PID's temp files; list/status report the dead
record until cleanup, after which the stable ID can start exactly one new host.

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
