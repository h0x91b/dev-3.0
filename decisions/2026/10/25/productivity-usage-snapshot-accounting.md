# Productivity usage snapshot accounting

## Context

Productivity Stats reconstructs API-equivalent costs from local agent logs. The dashboard parser differed from the separate harness audit: it counted repeated Codex deltas and discarded Claude response updates, and its filesystem scan omitted managed accounts and Codex archives.

## Investigation

Codex token-count events can repeat a last-usage delta with an unchanged cumulative total at a different timestamp. Claude streamed response blocks share message/request identity and update the usage snapshot; first-record deduplication loses the final output count.

## Decision

In `agent-usage-parse.ts`, `foldCodexEntry` suppresses repeated cumulative token snapshots within each rollout while preserving event deduplication across files. `foldClaudeEntry` replaces older response snapshots by timestamp, using the larger output count to break timestamp ties, and removes the prior contribution before rebucketing. `getAgentUsage` scans the configured default homes, registered managed homes, and both active and archived Codex stores.

## Risks

The local log formats are implementation details and can evolve. Cumulative deduplication resets per file because independent sessions can have identical totals; logs without usable cumulative totals retain timestamp-based deduplication. Costs remain estimates using the local model rate table, with unknown models marked as partially priced.

## Alternatives considered

Timestamp-only Codex deduplication counts rate-limit refreshes as new usage; installation-wide cumulative deduplication loses legitimate usage in independent sessions. Keeping only the first Claude snapshot undercounts streamed responses, while summing all snapshots charges repeatedly for the same response.
