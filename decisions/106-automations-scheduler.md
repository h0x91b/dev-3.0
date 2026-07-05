# 106 — Automations: in-house RRULE subset + at-least-once scheduler in the main process

## Context

Automations (scheduled agent runs, borrowed from superset) need a recurrence engine (RFC 5545 RRULE + timezone), persistence, and a scheduler that fires while the app — desktop or `dev3 remote` headless — is running. Superset's documented gaps: no completion tracking, silent offline skips, at-least-once delivery surprises.

## Decision

1. **In-house RRULE subset, no `rrule` npm dep** (`src/shared/rrule.ts`): FREQ=HOURLY/DAILY/WEEKLY/MONTHLY + INTERVAL/BYDAY/BYMONTHDAY/BYHOUR/BYMINUTE; timezone math via `Intl` two-pass offset correction. Unknown parts are hard parse errors, never silent skips.
2. **Per-project `data/<slug>/automations.json`** (`src/bun/automations-data.ts`) — rule-5 additive parallel file; older app versions never read it; atomic writes under the file lock.
3. **Scheduler ticks every 30 s in the bun main process** (`src/bun/automations-scheduler.ts`), started from `index.ts` (runs in headless too). The clock (`nextRunAt`) is advanced and persisted **before** the task spawns, so a crash mid-fire can at worst refire one occurrence — bounded at-least-once; template prompts are written idempotent. Occurrences older than a 5-minute grace are **missed**, recorded in run history and surfaced via the `automationRunsMissed` push (toast); `catchUp: "runOnce"` promotes exactly one catch-up fire, never one task per missed slot.
4. **A fire creates an ordinary task** (`createAutomationTask` in task-lifecycle.ts): prompt = description, background worktree+PTY preparation (same pipeline as Launch Variants), `Task.automationId` provenance + clock glyph on the card.

## Risks

- DST-nonexistent wall times fire at the shifted instant (documented in rrule.ts) — acceptable for this use case.
- At-least-once on crash-mid-fire: a duplicate task is possible; prompts must derive state at run time (templates do).
- `evaluateDue` caps missed-occurrence listing at 50 per automation (bounds pathological hourly rules).

## Alternatives considered

- **`rrule` npm package**: full RFC coverage but a heavy dep with known timezone quirks; the product needs 4 frequencies, not EXDATE/BYSETPOS.
- **Fire on exact `setTimeout` per automation**: precise but fragile across sleep/wake; a 30 s poll matches the existing poller pattern and the 5-min grace makes lateness invisible.
- **One catch-up task per missed occurrence**: rejected — an offline week must not flood the board (superset's at-least-once complaint).
