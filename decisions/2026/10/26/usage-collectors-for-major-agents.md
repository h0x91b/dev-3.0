# Usage collectors for major agents

Extended on 2026-10-26 by [usage collectors for OpenCode, pi and Oh My Pi](usage-collectors-opencode-pi-omp.md).

## Context

Productivity Stats previously collected only Claude Code and Codex, leaving other supported harnesses outside its token and API-equivalent cost totals. The same retained-history and refreshed-price behavior must apply to Gemini CLI, Cursor Agent and GitHub Copilot CLI.

## Investigation

[Gemini chat records](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts) store per-response token counts, including cached input and additional thinking output. Cursor's local transcripts omit accounting, while its [response and stop hooks](https://cursor.com/docs/agent/hooks) expose generation-level usage; the installed interactive CLI subtracts cached tokens before reporting input. Copilot persists cumulative per-model accounting in [usage checkpoints and shutdown events](https://github.com/github/copilot-sdk/blob/main/nodejs/src/generated/session-events.ts); context occupancy and premium-request multipliers are not consumed tokens or dollars.

## Decision

The collectors normalize native usage into shared raw snapshots, and the handler retains and prices all five sources. Gemini uses session/message identity; Cursor installs additive user-level hooks on launches or `dev3 install-hooks`, writes only allowlisted accounting locally, and deduplicates response/stop records by conversation/generation. Copilot retains checkpoints and differences chronological per-counter high-water marks within each session/model before daily bucketing. New sources use separate additive history files so older two-source app versions cannot erase them; Google rates and known native model aliases join the daily pricing catalog.

Cursor accounting intentionally covers local sessions outside dev3, matching the global Claude/Codex scan; it does not use the task-only lifecycle guard. Installation skips absent Cursor configuration unless launching a configured Cursor agent, and generated commands check that dev3 still exists. `dev3 install-hooks --remove-cursor` removes only managed usage entries before uninstalling, without requiring the app or a task.

## Risks

Cursor collection starts after hook installation and requires versions that supply usage; old transcripts, cloud agents and other machines cannot be backfilled. Older active or crashed Copilot sessions may provide no durable accounting until shutdown, and a first cumulative checkpoint cannot reconstruct earlier daily attribution. Unknown models remain explicitly unpriced; API-equivalent estimates do not represent subscription bills, credits or provider-specific premiums.

Unchanged history merges skip disk writes, but reads, retained identities/tombstones and the Cursor hook ledger still grow with usage. A future scaling change should use an identity-preserving journal/snapshot or partitions, compacting the Cursor ledger only after its snapshots are durably retained; daily dollar-only totals or expiring identities would break repricing and deduplication. This change performs no destructive retention or format migration.

## Alternatives considered

Inferring tokens from transcript text or interpreting request credits as dollars would manufacture usage and cost. Cursor's team-admin API requires separate privileged credentials, so it cannot serve as a default personal history source. Replacing the original combined history format would let older app versions discard the new sources, while per-source files preserve their data without a destructive migration.
