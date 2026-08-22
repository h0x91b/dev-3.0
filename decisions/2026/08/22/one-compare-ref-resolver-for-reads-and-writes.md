# One compare-ref resolver, for reads AND writes

## Context

`decisions/2026/08/21/compare-base-without-a-remote.md` made the comparison base
remote-aware and named `resolveCompareRef` the "single server-side answer to what
we compare against". It was applied to the READ path only — `getBranchStatus`,
`getUnsavedWork`, `getTaskDiff`, `healDeadCompareBase`. The buttons kept their own
`params.compareRef || \`origin/${baseBranch}\`` fallback.

So in a project with no remote (Seq 1642) the dropdown correctly said `master`,
and pressing Rebase ran `git fetch origin master` (exit 128, "continuing") and
then `git rebase origin/master` → `fatal: invalid upstream`, with failure advice
telling the user to resolve conflicts that did not exist.

## Investigation

The renderer sends `compareRef: ""` whenever the server owns the choice, so the
server's fallback IS the answer in the default case — and it was a different
computation from the one the status line used. `git-diff-no-remote.test.ts` proved
the resolver and never touched a call site, which is why it stayed green.

## Decision

1. `resolveCompareRef` moved from `rpc-handlers/git-operations.ts` into
   `src/bun/git.ts`, so every process-side caller shares one function. No caller
   in `src/bun/` spells `origin/${baseBranch}` any more: `rebaseTask`,
   `rebaseTaskViaAgent`, `mergeTask`, `lifecycle/activities` merge watch,
   `lifecycle/executor` completed-diff stats, `productivity-stats` live diff and
   `resolveBugHunterCompareRef` all go through it.
2. `mergeTask` takes a `compareRef` param and the renderer passes the same value
   it displays, so its "branch is not rebased" guard cannot measure against a
   different ref than the badge did. That guard previously compared against a
   nonexistent `origin/<base>` in a remoteless repo and therefore never fired.
3. `fetchFromRemote` (`git.ts`) returns false without spawning when the repo has
   no such remote, killing the doomed background fetch everywhere at once.
   `rebaseGitOpSpec` takes `fetchBranch: string | null` and emits NO fetch step for
   a local target — the pane's "Fetch exited with 128 — continuing" line is gone
   because the fetch is not attempted.
4. `rebaseTask` verifies the target ref exists (fetching once first if it is a
   remote ref) and throws before opening a pane. A pane that can only print
   `invalid upstream` plus conflict advice is worse than a refusal in the UI.
5. Coverage asserts the ACTION: `rpc-handlers/__tests__/git-op-compare-ref.test.ts`
   drives the handlers and reads the script text that reaches the pane, with a
   remote-present positive control. Each assertion was proven by reverting the fix.

## Risks

- The merge-watch activity now uses the local base in a remoteless repo, so a
  locally merged branch starts offering "Branch Merged → complete the task?" where
  it previously never did. That is the intended behaviour, but it is new prompting
  in local-only projects.
- `fetchFromRemote` pays one `git remote` read per fetch call before its spawn.
  Cheaper than the `git fetch` it replaces, and the existing cooldown still applies.
- A remote-tracking target that has never been fetched is now refused with "does
  not exist" instead of being fetched by the pane — mitigated by the one fetch
  attempt inside the preflight.

## Alternatives considered

- **Patch `rebaseTask` alone.** It is the button the user pressed, but the same
  idiom sat in six other places; fixing one leaves the next caller free to drift.
- **Disable Rebase with no remote.** Rejected for the same reason the 2026-08-21
  record rejected disabling comparison: rebasing onto a local base is a real,
  working operation.
- **Make the failure message exit-code aware** (conflict advice only on exit 1).
  Worth having, but it treats the symptom; the pane should not open at all for a
  ref that is not there.
