# Per-task Claude session stats: an attention strip in the usage panel, the full list on its own screen

## Context

The header usage panel showed only account-wide limit windows (5h, 7d). Users wanted the session details a custom Claude Code statusLine shows: context use, prompt cache warm/cold and expiry, cache reads and writes, cost. Claude Code already sends all of it in the statusLine payload that `dev3 statusline` receives on every refresh. The first version listed recent sessions inside the usage panel, but a 28rem hover panel cannot hold 40 parallel tasks under several accounts.

## Investigation

The account dumps (`rate-limits/claude.json`, `rate-limits/claude/<accountId>.json`) are last-writer-wins, so per-session values from them belong to an arbitrary task. Every dev3-launched agent has `DEV3_TASK_ID` in its environment. `prompt_cache.hit_ratio` is a token share, not a request share: a live payload had 22 requests, 0 misses and a 0.96 ratio. A 5m cache is warm only within 5 minutes of the last request, so "expires in under 5 minutes" is true of every warm 5m cache.

## Decision

- **Data.** `dev3 statusline` also writes its `{capturedAt, accountId, payload}` envelope to `rate-limits/sessions/<taskId>.json` (`sessionDumpFilePath`). `readClaudeSessionDumps` and `attachTaskIdentity` in `src/bun/rate-limit-monitor.ts` read dumps from the last `SESSION_STATS_RECENT_MS`, drop gone or finished tasks, set `awaitingUser` for `user-questions` / `review-by-user`, and put every session, uncapped, in `AgentRateLimitsReport.sessions`.
- **Attention.** `sessionAttention` in `src/shared/session-stats.ts` flags a warm cache expiring within 5 minutes only while the task waits on the user, because a working agent refreshes its own cache. It also flags context at 85% or more. The panel's `UsageSessionsStrip` shows one summary line and at most `MAX_ATTENTION_SESSIONS` (3) flagged rows. It never grows with the task count.
- **Full list.** The `sessions` route (`SessionsScreen`) is a sortable, searchable table with a project scope. Rows open their task and expand to the remaining statusLine fields. Entry points: the strip's "All sessions" link and the `view-sessions` palette command.
- **No field picker.** The columns are fixed, and the rest is a per-row disclosure, so there is no setting.

## Risks

The `sessions/` directory gains one small file per task that ran Claude and is never pruned. Stale files are ignored by mtime, per the no-destructive-cleanup rule for `~/.dev3.0/`. Several Claude panes in one task share a file, so the row shows whichever refreshed last. `awaitingUser` follows the board status the hooks set, so a stuck status misplaces a row in the strip. Older dev3 builds ignore the directory and the optional `sessions` field.

## Alternatives considered

- **Per-session values from the account dumps.** Wrong task attribution as soon as two sessions run.
- **Parsing Claude transcripts.** Heavier, and the prompt-cache state is not in them.
- **A cascading submenu off the panel.** Hover-on-hover inside a dwell-gated panel closes on a diagonal pointer path, has no touch form, and 40 rows still scroll.
- **A modal for the full list.** The UX manifest forbids a persistent dashboard in a modal.
- **A chip on each task card.** Card space is spent, and it gives no single place to compare costs. It remains a possible follow-up.
- **The Settings field picker of the first version.** Configuration for a readout; fixed columns plus a disclosure cover the same fields.
