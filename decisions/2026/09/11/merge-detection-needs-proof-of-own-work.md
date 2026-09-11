# Merge detection asks for proof of own work, not an empty diff

## Context

A brand-new task — agent still asking its first clarifying question, not a line
written — was offered "The branch is in the base branch / The merge is complete.
Is the task complete too?" with a **Complete task** button. Reported with a
screenshot of task #71 in a local-only project whose branch had only been renamed
(`dev3/task-b498e2da` → `feat/dev3-colony-grass-test-map`).

## Investigation

`isContentMergedInto` (`src/bun/git.ts`) answered *true* for a branch with no
commits of its own: `git merge-tree ref HEAD` equals `ref^{tree}`, and the
patch-id path had an explicit `return true; // no task changes`. The old suite
even pinned it — *"returns true when the branch carries no changes at all (empty
diff)"*.

Two callers guarded around it, one did not. `getBranchStatus`
(`src/bun/rpc-handlers/git-operations.ts`) already skipped the content check when
`ahead === 0`. The merge poller (`checkMergedBranches` in
`src/bun/lifecycle/activities.ts`) only skipped it when `origin/<branch>` was
missing — and a project with **no origin at all** forces `unpushed = 0` and goes
straight into the content check. That is the reported repo.

## Decision

`isContentMergedInto` now resolves the `ahead === 0` case itself, in
`isMergedWithoutOwnCommits`: the graph cannot separate "never committed" from
"work merged", so it demands positive proof — a merge commit in `ref` whose
parent is HEAD, or a tip this branch once committed (its own reflog, work-producing
entries only) that `ref` now contains. No `gh` call on that path; callers keep
their own PR proof. Both callers now go through it, so a purely local merge
(including a fast-forward) is detected where previously only a merged GitHub PR
counted.

## Risks

- **Reflog is the only witness of a fast-forward merge.** A pruned reflog (90-day
  expiry) or a branch this machine never committed on degrades to "not merged" —
  quiet, never a false prompt.
- **Squash merge followed by a rebase is no longer detected locally**: the branch
  tip becomes the base tip, byte-identical to an untouched branch that rebased
  onto the base. Only the task's own merged PR separates them, and that proof
  lives in both callers. `rebase` is deliberately excluded from the reflog
  prefixes for exactly this reason.

## Alternatives considered

- **Guard the poller only** — leaves the landmine in `isContentMergedInto` for
  the next caller, and keeps two different answers on two surfaces.
- **Require a merged PR whenever `ahead === 0`** — simple, but blind to local
  merges in repos with no GitHub remote, which is the very project that hit this.
- **Store the branch's creation commit in the task** — the exact answer, but it
  is new on-disk state that old app versions would not write, so tasks created
  before it would stay undecidable.
