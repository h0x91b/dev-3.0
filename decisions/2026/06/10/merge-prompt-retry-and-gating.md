# 066 — Merge-completion prompt: retry window, pruned-branch fallback, dirty/compare gating

## Context

The "PR merged — complete the task?" popup periodically misbehaved: it silently never appeared for some merged tasks, and could appear when it shouldn't. Live data showed tasks stuck with `mergeCompletionPrompt.promptedAt` set, `dismissedAt: null`, still in review — the popup was reserved but the user never saw it (app restart / undelivered push), and the precise-fingerprint suppression in `shouldSuppressMergePrompt` muted it forever.

## Investigation

Five independent problems were confirmed in `src/bun/rpc-handlers/git-operations.ts` and `src/mainview/components/task-info-panel/useTaskBranchStatus.ts`:
(A) prompt state is persisted *before* display, and precise fingerprints were suppressed permanently regardless of `dismissedAt`; (B) `getUnpushedCount === -1` (remote branch pruned by `delete_branch_on_merge`) skipped detection entirely; (C) no uncommitted-changes check before a popup that claims "no changes left"; (D) the UI prompt fired for `mergedByContent` computed against any user-selected compare ref; (E) dismissed tasks re-ran merge-tree/patch-id/gh checks every 60s forever.

## Decision

Permanent suppression now requires an explicit `dismissedAt`; an unanswered reservation only mutes re-prompts for 1h (`MERGE_PROMPT_RETRY_SUPPRESS_MS`), and the in-memory key set became a `Map<promptKey, reservedAt>` with the same TTL. Strategy 3 of `isContentMergedInto` was extracted into `git.isBranchMergedViaGitHubPR` (trusted only when the merged PR's `headRefOid` equals local HEAD) and is used by the poller when the remote branch is gone. The poller checks suppression first, then skips dirty worktrees *without* reserving; the UI prompt additionally requires a clean worktree and the default base compare ref.

## Risks

A user who ignores the popup (closes it without answering) will see it again an hour later — intentional, but a behavior change. The pruned-branch path adds a gh API call per never-pushed review task per minute; acceptable against the 5000/h limit and offset by the savings from (E).

## Alternatives considered

Persisting "popup actually displayed" acknowledgements from the renderer would remove the reserve-before-display race entirely, but requires a new RPC round-trip and still fails on renderer crash; the retry window is simpler and self-healing. Treating `unpushed === -1` as merged when content strategies pass was rejected: a never-pushed branch with zero commits trivially "matches" the base and would false-positive.
