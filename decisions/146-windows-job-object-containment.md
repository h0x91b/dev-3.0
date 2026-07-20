# 146 — Windows Job Object containment for detached PTYs

## Context

The detached PTY tracer reattached to the same PowerShell PID and state on Bun
1.3.14, but stopping host PID `2572` and root PID `10584` left nested PowerShell
PID `14600` alive. This follow-up must own the Windows tree without entering the
production tmux spawn, attach, or stop graph.

## Investigation

[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
assign children to every non-breakaway job in their parent's chain at process
creation, and kill-on-close terminates all members with the final handle.
[Bun FFI](https://bun.sh/docs/runtime/ffi) represents Win32 `HANDLE` values as
`u64`; direct `kernel32.dll` calls suffice here, but FFI remains experimental.

## Decision

`windows-job.ts` creates a unique token-named Job Object, enables kill-on-close,
and enrols the detached host before `host.ts` calls `Bun.spawn`; the root shell
and every descendant therefore inherit containment without an assignment race.
Stop sends Ctrl-C plus `exit`, waits 1.5 seconds, clears token-matched metadata,
then closes the owning handle; launcher fallback terminates only that named job.

## Risks

Nested-job assignment can fail under an incompatible outer job, and Bun FFI has
known limitations. Such a failure occurs before the native root shell spawns and
cannot touch tmux; the prototype logs the Win32 error and aborts startup. Because
the host is a job member, forceful close intentionally ends it after cleanup.

## Alternatives considered

A post-spawn `AssignProcessToJobObject` was rejected because descendants can race
the assignment. A signed helper remains plausible for production hardening, but
adds architecture builds, signing, updater, and version-skew work without helping
this isolated proof; revisit it with runtime packaging. `taskkill /T` and PID
walks were rejected as PID-scoped snapshots rather than durable ownership.
