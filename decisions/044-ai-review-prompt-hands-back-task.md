# 044 — AI Review Prompt Hands Task Back

## Context

After dragging a task to AI Review, the review agent ran the default prompt and committed fixes, but the task stayed in `review-by-ai` until the agent exited. The user wanted the task to move on automatically based on review outcome:

- Issues found / fixes committed / anything worth surfacing → `user-questions` (Has Questions)
- Diff clean, nothing changed → `review-by-user` (Your Review)

## Decision

Extended `DEFAULT_REVIEW_PROMPT` in [src/shared/types.ts](../src/shared/types.ts) with an explicit final step: the agent itself runs `dev3 task move --status user-questions` (plus a short `dev3 note add`) when it touched anything, or `dev3 task move --status review-by-user` when the diff is clean. The prompt now ends with a mandatory "move the task exactly once, at the end" instruction.

No backend changes. The existing `onExitCommand` in `triggerColumnAgentIfNeeded` and the Claude/Codex Stop hooks all guard the transition with `--if-status review-by-ai`, so if the agent already self-moved to `user-questions` or `review-by-user`, they become no-ops. If the agent forgets or crashes, the safety net still drops the task into `review-by-user`.

Chose the prompt-only approach per the user's instruction — no reliable backend heuristic exists to distinguish "found issues" from "clean" without the agent itself telling us.

## Risks

- Prompt-following is not guaranteed. An agent that ignores the final step will end up in `review-by-user` via the safety net — acceptable degraded behavior, but means the `user-questions` signal is best-effort.
- Custom `builtinColumnAgents["review-by-ai"].prompt` values saved by users will not include the new hand-back instructions. They still rely on the safety net to land in `review-by-user`.

## Alternatives considered

- **Backend heuristic** (inspect git log during `onExitCommand` to decide the target status): rejected — too fragile; "committed fixes" vs. "clean" is not a reliable proxy for "has questions" (agent might commit trivial reformatting).
- **Two separate prompts / UI buttons**: rejected — user explicitly preferred "just do it in the prompt".
