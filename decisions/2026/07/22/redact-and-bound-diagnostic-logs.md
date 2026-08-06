# 158 — Redact and bound local diagnostic logs

## Context

The diagnostic logger serialized arbitrary RPC extras and retained daily files indefinitely. Task creation and agent launch diagnostics therefore persisted full prompts and resolved command lines, including injected instructions and credentials embedded in arguments or URLs.

## Investigation

The highest-risk paths were `createTask` params, PTY launch command fields, preparation spawn tracking, and direct `git`/`gh` command strings. These paths share the logger, so call-site-only redaction would leave future or less obvious log calls exposed.

## Decision

`src/bun/logger.ts` now sanitizes nested payloads centrally, summarizes command shape as executable plus argument count, and prunes dated files to a 14-day window after the first successful write each day. Direct command diagnostics use static event messages plus structured fields; local error messages, stacks, and command output remain available for troubleshooting, while file writes, serialization, and cleanup stay best-effort.

## Risks

Redaction is key-based, so a new payload field with an unrecognized name could bypass it. New diagnostics must use the existing sensitive field vocabulary or add the field to the logger policy, and commands must live in recognized command fields rather than interpolated event messages.

## Alternatives considered

Redacting only the known PTY and task-creation call sites was rejected because generic RPC params, git/gh helpers, and future logger users could still persist secrets. Removing all failure details was also rejected because exit codes, IDs, durations, and failure metadata are required for production diagnosis.
