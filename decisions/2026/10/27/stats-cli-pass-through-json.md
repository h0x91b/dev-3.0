# Stats and approvals CLI: pass-through socket methods, CLI-side filters

## Context
The Stats page, rate-limit indicator, memory widget and approval dialogs read renderer-only RPC. Agents outside the app (the OpenClaw bridge) need the same numbers, and the CLI's `--json` is the only versioned contract dev3 offers; a raw socket call or a read of the data files would break silently on an update.

## Decision
`src/bun/cli-socket/stats-commands.ts` maps `stats.productivity|usage|limits|memory` straight onto the existing `handlers.getProductivityStats|getAgentUsage|getAgentRateLimits|getSystemMemory`, so the CLI and the Stats page can never disagree. `--project` and `--since` filter in the CLI (`src/cli/commands/stats.ts`), which keeps the socket methods parameterless. `approvals.list` reads `listPendingApprovalSummaries()` in `agent-requests.ts` and never shows, holds or answers a dialog. Its context comes from the `dialog` each caller passes to `createAgentRequest`, launches included (`requester` added for them), not from `launchDialog`: setting that on the move/scratch path would also make those dialogs replay on renderer reconnect, a behaviour change this read-only PR stays out of. Top-level times the CLI adds are ISO; nested renderer payloads keep their recorded units (rate-limit snapshots are epoch ms), and the help says so. Every `--json` object carries `schemaVersion: 1`; the payloads are the renderer's own types, and the CLI tests build their fixtures against those types, so renaming a field fails lint there before it silently changes the contract.

## Risks
Filtering client-side means `stats productivity` still computes a live diff for every active worktree on every call, as the Stats page does. Pending approvals live in one app process's memory: a restart drops them and a second instance does not see the first one's.

## Alternatives considered
An explicit field-by-field projection per command, like `task-json.ts`: safer against internal renames but ~100 lines of mirrored fields for four reports whose types already are the renderer's public surface. Server-side filter params: more socket surface for no saving, since the handlers cannot skip work for a filtered project today.
