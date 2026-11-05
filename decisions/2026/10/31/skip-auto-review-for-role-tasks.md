# Automatic AI review skips coordinator, pr-review and board-cleanup tasks

## Context

With `autoReviewEnabled`, every primary-agent Stop moved the task to `review-by-ai`, whatever its type (h0x91b/dev-3.0#2127). A coordinator ends many short turns and writes no code, so each turn launched an xhigh reviewer on an empty diff and bounced the card through three columns; a `pr-review` task got reviewed itself.

## Decision

`getPrimaryStopTarget(autoReviewEnabled, taskType)` in `src/shared/types/column-agents.ts` is the single place that decides where a primary turn ends; it returns `review-by-user` for `coordinator`, `pr-review` and `board-cleanup`. Both hook families use it: the Stop target baked into Claude's `settings.local.json` (task launch, column agent, spawned pane, resume, bug hunters, and the pre-prompt refresh in `agent-hooks-refresh.ts`), and the socket path for Codex/omp/pi/Copilot, where `getAgentHookTargetStatus` now takes that computed target instead of a bare boolean. Gemini installs no status hooks and Cursor only usage hooks, so neither routes anything.

A type change on a live Claude task is picked up immediately: `dev3 task update --type` delivers the role brief through `deliverAgentPrompt`, which re-asserts the hooks with the updated task before typing.

## Risks

A Claude session whose type changes by some path other than `dev3 task update --type` keeps the old Stop target until the next dev3-delivered prompt or relaunch. Someone who genuinely wants a pr-review task auto-reviewed must drag it to AI Review by hand.

## Alternatives considered

Skipping review when the worktree has no diff against its base (issue option 2) was rejected for now: it needs a git call on every Stop, and "no diff" is ambiguous for a standard task that just answered a question versus one that committed and pushed. A per-task `--auto-review on|off` switch (option 3) is a feature, not a fix, and can layer on top of this later.
