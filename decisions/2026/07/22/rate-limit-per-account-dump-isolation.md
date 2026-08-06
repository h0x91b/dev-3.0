# 155 — Rate-limit dumps: isolate managed accounts from the shared claude.json

## Context

The agent rate-limit panel kept losing Claude accounts: an account would appear,
then vanish the moment another Claude session ran. Users with several configured
logins could only ever see one or two at a time.

## Investigation

`dev3 statusline` (`src/cli/commands/statusline.ts`, `dumpPayload`) wrote the
payload to the shared `~/.dev3.0/data/rate-limits/claude.json` on **every**
refresh, plus a per-account file only when a managed account id env was set.
`claude.json` is a single slot keyed by whatever `accountId` it last carried, so
a managed session (or the system login) writing it clobbered the previous
account's data. The monitor's 24h activity window (`RATE_LIMIT_ACTIVITY_WINDOW_MS`)
then dropped anything not seen in a day. Confirmed on disk: `claude.json` and the
one per-account file both held the same active-session `accountId`, while other
recently-used accounts had no surviving record.

## Decision

- `claudeDumpFilePaths(accountId)` (exported, unit-tested) now routes writes:
  a managed account writes **only** its per-account file
  (`rate-limits/claude/<id>.json`); the system login (no managed id) writes
  **only** `claude.json`. No session clobbers another's slot.
- `RATE_LIMIT_ACTIVITY_WINDOW_MS` widened 24h → 7 days (`src/shared/rate-limits.ts`),
  matching the 7-day limit windows, so every account used within a week stays.
- The panel shows a per-account "captured {time} ago" note (warning tint past
  `STALE_AFTER_MS`) so a reading from days ago never reads as live
  (`RateLimitIndicator.tsx`, `CapturedNote`).

## Risks

- An N-2 dev3 build reading `claude.json` now sees only the system login, not
  managed accounts (managed multi-account limits are a recent feature; degrades
  gracefully). Additive on disk — no rename/move/delete, honouring the frozen
  `~/.dev3.0/` layout invariants.
- A stale `claude.json` left by an older build may still carry a managed
  `accountId`; the monitor dedups it against the per-account file and it
  self-heals once the system login next refreshes.

## Alternatives considered

- Keep writing `claude.json` for all sessions and dedup harder in the monitor —
  cannot recover data already overwritten in the single slot.
- Embed account identity from Claude's statusLine payload — the payload does not
  reliably carry a stable managed-account id; the env-provided id is the only
  distinguisher.
