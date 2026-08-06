# Reopening a task answers the merge prompt for the head it comes back on

## Context

Pulling a task back out of Completed (or Cancelled) recreates its worktree on the
same branch — which is usually already merged into the base. Both merge surfaces
then fired within seconds: the 60s merge poller (`checkMergedBranches`) and the
info panel's 15s branch-status poll, each offering "The branch is in the base
branch — is the task complete too?". Accepting the prompt earlier does not record
a dismissal (only "Not now" does), and a task completed by hand records nothing at
all, so the existing suppression in `shouldSuppressMergePrompt` had nothing to
match against.

## Decision

`preparationSucceeded` now emits a `dismissMergePromptForCurrentHead` effect when
the preparation's origin column was terminal and the project is a git project
(`src/bun/lifecycle/machine.ts`). The executor resolves the fingerprint from git
HEAD and writes `mergeCompletionPrompt` with `dismissedAt` set, plus an actor
reservation so the notice-only toast is muted too
(`src/bun/lifecycle/executor.ts`). `getMergeCompletionFingerprint` moved to
`src/bun/lifecycle/merge-fingerprint.ts` so the executor can use it without
importing the poller module.

Scope is deliberately one head: work committed and merged after the reopen has a
new fingerprint and prompts normally. Setting `manualCompletion` instead would
silence the task forever, which is a different (user-owned) decision.

## Risks

If HEAD cannot be read the fingerprint falls back to `fallback:<branch>`, which
suppresses for one hour instead of permanently — the prompt can reappear on a
reopened task whose worktree git call failed. Reopening a task whose branch is
*not* merged now also records a dismissal for that head; harmless, because the
poller only prompts once a merge is detected, and by then the head that merged is
usually a later one.

## Alternatives considered

- Auto-set `manualCompletion` on reopen — sticky, hides a legitimate prompt after
  the next real merge, and silently flips a flag the user reads in `task show`.
- Skip merge detection for N minutes after a reopen — a timer hides the symptom
  and still prompts once it expires.
- Suppress prompts on the client after a reopen — leaves the CLI/poller path and
  a second window prompting anyway.
