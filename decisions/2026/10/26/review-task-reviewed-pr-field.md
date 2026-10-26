# Review tasks store the PR they review in `reviewedPr`, not `prNumber`

## Context

A review task (`taskType: "pr-review"`, `foreignCode`) had no persisted link to the pull request it reviews. `--pr` resolution and the creation-time title probe both found the number and threw it away; only `existingBranch` survived. The card, sidebar row and git bar therefore had nothing to link, and the only "#2067" on screen was inside the agent-renamable title.

## Decision

A separate additive task field `reviewedPr: { number, url }` (`src/shared/types/task.ts`). `createTask` fills it from the same lookup that drafts the review title (`reviewIdentityForBranch` in `src/bun/rpc-handlers/task-lifecycle.ts`), so title and link cannot disagree. Tasks created before the field get it from `resolveReviewedPr`, which the renderer calls at most once per task per session (`useReviewedPrBackfill`); a miss is not persisted. The lookup is `github.findPullRequestForHead`: `gh pr list --head` matches a branch NAME only, so it filters by the fork remote the ref came from (`git.forkRemoteOf`) and accepts any state, preferring an open PR. `ReviewedPrLink` renders it in neutral ink on all three surfaces and yields to the own-PR badge when both name the same PR.

## Risks

A legacy review task whose branch has no matching PR shows no link (graceful, by design). The lookup trusts that the fork remote is named after its owner, which is how `git.fetchFork` names it.

## Alternatives considered

Reusing `prNumber`/`prUrl`: rejected. Those fields mean "this task's own PR" and drive PR polling, merge detection and completion prompts, so a reviewed PR merging would suggest completing the review task. Parsing "#N" from the title: rejected. The agent owns the title and rewrites it.
