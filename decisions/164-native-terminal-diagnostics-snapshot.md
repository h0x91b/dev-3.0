# 164 — Native terminal diagnostics snapshot (injected data, allowlist redaction)

## Context

The tmux-removal roadmap (seq 1141, HOST-009) needs a way to inspect a native
terminal session's health from CLI/UI later. This task (seq 1258) builds only the
snapshot + formatter, in strict isolation: it must not modify or couple to the
registry, host, adapter, protocol, or parser, yet must expose their facts.

## Decision

New pure module `src/bun/native-terminal-diagnostics/` (`snapshot.ts`,
`format.ts`, `index.ts`). `buildDiagnosticsSnapshot` takes **injected plain data**
mapped from existing public read APIs (`registry.status()` → `NativeSessionRecord`
+ `StatusReply` + `OwnershipVerdict`, `ParserEventQueue` getters, a
`ParserStateSnapshot`) and produces a versioned, JSON-safe snapshot. Every fact is
a `DiagnosticFact<T>` = `{known:true,value}` | `{known:false,reason}`. Redaction is
**structural/allowlist**: the builder only reads the required facts and never
touches endpoint, bearer token, host executable, start signatures, shell command,
env, or parsed output — so nothing in an ignored field can leak. `now`/`lastAttachAt`
are injected (no `Date.now`), giving deterministic, reproducible snapshots.

## Risks

The `Fact<T>` shape and snapshot schema are v1; a future breaking change bumps
`NATIVE_TERMINAL_DIAGNOSTICS_VERSION`. `lastAttachAt` is unknown until a caller
tracks it — the registry record and `StatusReply` do not carry it today (recorded
as the exact follow-up rather than probing for it).

## Alternatives considered

- Read the registry directly at runtime — rejected: violates the isolation
  boundary and couples diagnostics to host internals.
- Denylist redaction (copy everything, strip secrets) — rejected: fragile; one new
  secret field silently leaks. Allowlist is provable (see the redaction tests).
