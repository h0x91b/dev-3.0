# 151 — Persistent native-session registry format & lifecycle

## Context

The `detached-pty` spike (decisions 146, 150) proved a single detached host can
own one `Bun.Terminal` shell and be reattached without tmux. Seq 1214 (parent
1141, tmux-removal roadmap) needs that turned into a **persistent multi-session
registry**: start/list/status/attach/stop several native sessions by stable id,
survive launcher/client exit, serialise concurrent starts, and clean up dead
records — all as a parallel namespace that never touches production terminal
selection, UI, RPC, project/task schema, or tmux.

## Decision

A new self-contained module `src/bun/native-terminal-registry/` (it does **not**
import the removable spike). Each session owns a subdirectory under an additive
`~/.dev3.0/native-sessions/<sessionId>/` namespace (override
`DEV3_NATIVE_SESSIONS_DIR`) holding a versioned `record.json` (atomic
tmp+rename), a private `token` file (mode 0600, never in the record), a
`host.log`, and a bounded independent `journal.ndjson`.

- **Ownership evidence, not bare PIDs.** POSIX records a `ps -o lstart` start
  signature per host/shell PID; Windows uses token-named Job Object membership.
  `classifyOwnership` returns `owned`/`dead`/`reused` from passive probes only —
  it never opens the transport and never signals a PID (`ownership.ts`).
- **Serialised start.** `registry.start` runs its critical section under a
  per-session `withFileLock` (reusing `src/bun/file-lock.ts`): the loser sees the
  winner's live record and returns `already-running`, never a second shell.
- **Token-matched teardown.** `stop`/`cleanupStale` remove only state whose
  on-disk token matches and re-verify identity before any POSIX signal / Windows
  Job termination; unknown-schema records are left intact.

## Risks

Bun FFI (Windows Job Object) is experimental; a job-creation failure aborts only
this isolated host before its shell spawns and never reaches tmux. The POSIX
start signature depends on `ps -o lstart`; if `ps` is unavailable the signature
is empty and a session reads as `reused` (fail-safe: never falsely `owned`). The
journal is a bounded byte tail, not full terminal-state replay.

## Compatibility & protocol-negotiation boundaries

`schemaVersion`, `protocolVersion`, `hostArtifactVersion`, and `runtimeVersion`
are recorded so a future client can negotiate rather than adopt. `parseRecord`
returns null for any non-current `schemaVersion`, and `decodeControl` rejects any
non-current protocol version — an unknown record/frame is treated as
unreadable-and-not-ours and is never migrated, renamed, or deleted. This keeps
the shared `~/.dev3.0/` layout forward/backward compatible across dev3 versions
(AGENTS.md on-disk invariants) and leaves room for the eventual `TerminalBackend`
seam to introduce real capability negotiation.

## Alternatives considered

Extending the `detached-pty` spike in place was rejected — it is a removable
spike, and "persistent" contradicts "spike". A shared mutable index file listing
all sessions was rejected in favour of one directory per session (no cross-session
write contention, cleaner atomic per-session state). Storing the token inside
`record.json` was rejected because `list`/`status`/diagnostics serialise records;
the token lives in a private 0600 sibling instead.
