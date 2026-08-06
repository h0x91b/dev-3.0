# 171 — Native registry reboot recovery reuses the existing identity proof

## Context

After an OS reboot or a hard host loss, `~/.dev3.0/native-sessions/` records
outlive every process they describe (seq 1294, tmux-removal roadmap). The
registry already answered `owned`/`dead`/`reused`, but callers had no explicit
lost/stale lifecycle answer, and corrupt or partial records were silently skipped
by `list`, so an operator saw nothing at all.

## Investigation

The POSIX proof is `pid@ps -o lstart` — an absolute wall-clock start time — and
Windows proves membership in the token-named Job Object. Neither can survive a
reboot: every recorded PID is either gone (`dead`) or held by a process with a
newer start time / no Job membership (`reused`). So the existing identity proof is
already reboot-complete, and a boot-id or generation counter in the record would
add on-disk surface without changing a single verdict.

## Decision

No new identity mechanism and no boot framework. A pure classifier
([`recovery.ts`](../src/bun/native-terminal-registry/recovery.ts)) maps an
ownership verdict — or a record-read failure — to `attachable` /
`lost-host-gone` / `lost-pid-reused` / `unreadable` plus an actionable
diagnostic, with a `backend: "native"` marker on every entry.
[`inspectRecovery`/`recoverSessions`](../src/bun/native-terminal-registry/registry.ts)
expose it on the existing lifecycle API (also on `status()` as `recovery`), and
cleanup delegates to `cleanupStale`, keeping removal token-matched and
per-session locked. `inspectRecordFile()` in
[`record.ts`](../src/bun/native-terminal-registry/record.ts) reports *why* a
record was rejected (missing / torn JSON / foreign schema / invalid fields) so
unreadable state fails closed with a diagnostic instead of vanishing from the
report. Surfaced by `cli.ts recover [--cleanup]`.

## Risks

`recoverSessions({cleanup:true})` re-inspects after cleanup, so a session started
between the two sweeps appears in `after` but not `before` — reporting only, no
action is taken on it. A lost record whose token file is gone is never cleaned
automatically; it stays visible with a manual-removal diagnostic, which is the
intended fail-closed trade.

## Alternatives considered

A recorded boot id / machine generation was rejected as redundant (see
Investigation) and as unnecessary on-disk surface. Auto-restarting or adopting a
lost session, and falling back to tmux when native state is lost, were rejected
outright: recovery reports and cleans, it never re-creates a shell or changes the
backend choice.
