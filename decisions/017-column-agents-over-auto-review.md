# 017 — Column Agents over Auto-Review

## Context

The original AI Review design auto-triggered a review agent when the primary agent finished (Stop hook → review-by-ai → launch review). This was too slow and expensive — every task got reviewed regardless of need. Users wanted manual control.

## Decision

Replaced the auto-review flow with a generalized "Column Agent" system:

1. **Primary agent always stops at `review-by-user`** — the Stop hook no longer targets `review-by-ai`. Users must manually drag a task to the "AI Review" column to trigger a review agent.

2. **`ColumnAgentConfig`** replaces `AIReviewConfig` — stores `agentId`, `configId`, and `prompt`. Used for both the built-in `review-by-ai` column (`Project.builtinColumnAgents`) and custom columns (`CustomColumn.agentConfig`).

3. **`buildCmdScript` gains `onExitCommand`** — for `review-by-ai`, this runs `dev3 task move --status review-by-user --if-status review-by-ai` on successful exit. Custom columns have no `onExitCommand` (task stays).

4. **`reviewCompleted` field removed** — no longer needed since review is manually triggered.

Key files: `src/shared/types.ts` (data model), `src/bun/rpc-handlers.ts` (`launchColumnAgent`, `triggerColumnAgentIfNeeded`, `buildCmdScript`), `src/bun/cli-socket-server.ts`, `src/bun/data.ts` (migration), `src/mainview/components/ProjectSettings.tsx` (custom column agent UI), `src/mainview/components/KanbanBoard.tsx` (column visibility).

## Risks

- Legacy `aiReview` data is migrated on load; if a project file is read by an older app version, the `builtinColumnAgents` field will be ignored (graceful degradation).
- The `onExitCommand` runs unconditionally on exit code 0 — if the review agent exits 0 without doing anything, the task still moves to `review-by-user`.

## Alternatives considered

- **Keep auto-review but make it optional**: Rejected — the auto-review was the fundamental UX problem. Making it optional still means maintaining two code paths.
- **Column agents as a separate plugin system**: Over-engineered for the current need. Inline config on CustomColumn is simpler and covers the use case.
