# The comparison base survives a rename and retires when it dies

## Context

A task's git numbers — ahead/behind, the diff chip, the rebase target — are all
computed against `resolveTaskCompareBaseBranch(task, project)`. For a PR-review
task `deriveTaskBaseBranch` stores the reviewed branch itself as `baseBranch`,
and the function recognises that self-referential shape by `baseBranch` matching
`task.branchName`. A variant task deliberately keeps its source branch as the
base, and that is the *same* stored shape with a different `branchName` — the
two cases are told apart only by the branch name.

Observed on task Seq 1427: the agent renamed its branch, `syncTaskBranchName`
persisted the new name, the name-based guard stopped matching, and a foreign,
already-merged review branch became the comparison base. The header read
`21 ahead · 3 behind vs arditti/feat/dev3-terminal-file-path-open` with a
`213 files +15671 -792` chip. Every number was arithmetically correct against
that ref — a correct answer to the wrong question. "Rebase (AI)" instructed the
agent to rebase onto the dead branch; it refused only because it checked.

## Investigation

Three independent defects, each verified read-only against the live task:

1. The guard keys on `task.branchName`, which `syncTaskBranchName` rewrites.
   Any rename silently drops the protection.
2. Nothing ever retires the base. `mergeWatch` knows the branch merged and only
   offers task completion; `baseBranch` keeps naming the merged branch forever.
3. `fetchOrigin` could only fetch from `origin`, so a fork-qualified base
   (`arditti/feat/…`, resolving to `refs/remotes/arditti/feat/…`) was fetched as
   `git fetch origin arditti/feat/…` → `couldn't find remote ref`. The tracking
   ref stayed frozen at `42c01aaca` while the fork was at `49ebf7d5`.

Plus a latent one: with `ahead === 0`, `mergedByContent` was proved by
`task.prNumber` — here a *foreign* merged PR (#1255) — and the green PR badge
came from the same rot, falling back to the persisted number without checking
its state or its head branch.

## Decision

Four changes, each at the point where the information is lost.

- **Freeze the base across a rename.** `compareBasePin` in
  `src/bun/task-branch-sync.ts` resolves the base before and after the rename;
  if the rename would move it, the pre-rename answer is persisted into
  `baseBranch` — but only when it survives being stored, so renaming *onto* the
  base name is a no-op. Chosen over a new "checkout branch" field because the
  rename is the only event that destroys the signal, and healing there also
  repairs the stored data instead of re-deriving the truth on every read.
- **Retire a dead base.** `healDeadCompareBase` in
  `src/bun/rpc-handlers/git-operations.ts` falls a task back to the project base
  and persists it when the stored base is merged into `origin/<project base>` or
  no longer resolves. Only ever fires when the task's base differs from the
  project's own, so a project-wide `develop` base is untouched.
- **Fetch from the remote that owns the ref.** `git.fetchCompareRef` routes a
  `<remote>/<branch>` base to that remote (explicit refspec, so the tracking ref
  actually moves) and everything else to `origin`. Used by branch status, task
  diff, and the merge watcher.
- **Prove PR ownership.** `github.getPullRequestSnapshot` returns state *and*
  `headRefName`; `isPullRequestMerged` now takes the branch that must own the PR.
  The badge fallback and `pollTaskPrStatus`'s sticky-number lookup both drop a PR
  whose head is a different branch. A PR GitHub cannot answer for at all
  (offline, non-GitHub remote) keeps the stored badge rather than blinking out.

## Risks

- Retiring the base is a write on a 15s poll path; it is idempotent and guarded
  by `task.baseBranch !== resolved`, so it fires once. If a user deliberately
  compares against a merged branch, the `vs … ▾` dropdown still overrides it —
  that override lives in renderer state, not in `task.baseBranch`.
- The badge check costs one extra `gh pr view` for tasks with a stored PR and no
  open PR. It is cached per `(worktree, PR)` with a terminal-state fast path.
- `fetchCompareRef` spends one `git remote` per slashed base branch. Local, and
  skipped entirely for unslashed names.

## Alternatives considered

- **A persisted `checkoutBranch` field** to make the self-compare guard immune
  to renames. More robust in principle, but it adds a field that old tasks lack
  (so the heuristic stays anyway) and does nothing for the merged/deleted-base
  half of the bug.
- **Resetting `existingBranch` on merge.** It is provenance, and other flows read
  it; clearing it loses the record of what the task grew out of. Only the base is
  retired.
- **Blanking the PR badge whenever GitHub cannot confirm ownership.** Rejected:
  a transient network failure would flicker the badge off on every poll.
