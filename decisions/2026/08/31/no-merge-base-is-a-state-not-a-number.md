# No merge base is a state, not a number

## Context

The git bar on a task read `1889 ahead · 6 behind` for a branch GitHub reported
as 2 ahead / 7 behind of a 1894-commit `main`. The clone at
`~/Desktop/src-shared/dev-3.0` had become shallow (`.git/shallow` grafted at the
`v1.50.1` commit), so `main`'s visible history was 6 commits deep and no branch
older than that graft had a reachable fork point. Measured on 31 Aug 2026: 30 of
38 live task worktrees in that project were in this state.

The comparison base itself was not at fault — the
[`compare-base-without-a-remote`](../../21/compare-base-without-a-remote.md) and
[`one-compare-ref-resolver-for-reads-and-writes`](../../22/one-compare-ref-resolver-for-reads-and-writes.md)
records both stand. The ref was resolved correctly; it simply shared no history
with HEAD.

## Investigation

The two commands everything is built on disagree about that:

- `git rev-list --count --left-right <ref>...HEAD` does **not** fail. It silently
  degrades to the full symmetric difference and returns the size of each side's
  whole history. Both numbers of the bar come from this one command, so the near
  miss on `behind` (6 against GitHub's 7) was not a second bug or a stale fetch
  — it was the shallow depth happening to land next to the true value.
- `git diff <ref>...HEAD` **does** fail (`fatal: no merge base`), and
  `getBranchDiffStats` turned the failed command into `files: 0`. Those same 30
  tasks showed an empty branch diff that read as "no changes".

## Decision

`getBranchStatus` (`src/bun/git.ts`) probes `git merge-base` when both counts
come back non-zero — the only shape a missing fork point can produce — and
returns `{ ahead: 0, behind: 0, baseUnreachable: true }` instead of git's
degraded answer. `BranchStatus` and `UnsavedWork` carry the flag; the diff gets a
`no-merge-base` fallback reason next to the existing `missing-compare-ref`.

The zeros mean "unknown", which is what every consumer gated on them needs:
Push, Create PR, Merge and Rebase switch off, and each tooltip names the reason
rather than claiming there is nothing to push. Two places had to be taught the
difference between the two zeros explicitly: the local-squash merge guard, which
previously refused on `behind > 0` and would otherwise have started squashing
onto an uncompared base; and the completion dialog's never-pushed warning, which
counted with `ahead` and would otherwise have gone silent on a branch that
exists on no remote (`task.warnNeverPushedUnknownCount`).

## Risks

The probe adds one `git merge-base` per poll for any branch that is both ahead
and behind — milliseconds, next to the `git fetch` and `gh` calls the same poll
already makes. If a future git stops degrading `rev-list` this way the guard
becomes dead code; `git-shallow-no-merge-base.test.ts` asserts the degraded
output itself, so that change fails the suite rather than passing unnoticed.

## Alternatives considered

**Deepen the clone automatically** (`git fetch --unshallow` when the fork point
is missing). It fixes the cause rather than reporting it, but it hangs a 15s
poll on an unbounded network fetch, and dev3 never shallowed the repo in the
first place — nothing in `src/` passes `--depth`, `--unshallow` or `--filter`.
The honest state names the command instead.

**Fall back to two-dot counting** (`ref..HEAD` / `HEAD..ref`). It runs, but on a
truncated history it returns the same fabricated numbers — a lie with a
different derivation.
