# `dev3 pr create`: push to the fork, watch for the merge

## Context

A contributor without push access to `origin` could not use `dev3 pr create`: it
always pushed to `origin` and failed with 403, so agents fell back to raw
`gh pr create --head <owner>:<branch>` and skipped the task footer and the watch hint.
Separately, a merged PR left its task open for days: with the app's merge-completion
offer turned off, nothing woke the agent once its turn had ended, so it never asked
for completion.

## Decision

- **Push remote** (`pushBranch` in `src/cli/commands/pr.ts`): git's own
  `branch.<b>.pushRemote`, then `remote.pushDefault`, else `origin`. When `origin`
  refuses with a permission error and exactly one other remote exists, that remote
  gets the branch only if GitHub reports it as a fork of origin (`isForkOfOrigin`,
  `gh repo view --json parent`). Otherwise the command stops and names
  `git config remote.pushDefault <fork-remote>` rather than guessing.
- **Fork head:** for a non-origin push, `gh pr create` gets `--repo [HOST/]OWNER/REPO`
  of origin (the host kept for GitHub Enterprise) and `--head <owner>:<branch>` from the
  remote's push URL. A remote that is origin's own repository gets neither.
- **Merge watch:** inside a task, right after the PR opens and before auto-merge (whose
  failure exits), the CLI sends `pr.watch.add` with `until: "merged"` and no PR number,
  so the app resolves the branch's own PR. A number it could not tie to the branch would
  be stored as a "followed" PR, outside `mergeOfferHeld`. The merge then reaches the
  agent first, and the protocol tells it to request completion. An unreachable app falls
  back to the old hint; `pr create` still works with dev3 closed.

## Risks

Every task PR now wakes its agent once at merge. GitHub may not list a PR for its branch
seconds after creation; then no watch is stored and the CLI prints the manual hint. A
stalled app socket delays `pr create` by up to 20 s.

## Alternatives considered

Only honouring `remote.pushDefault`: correct, but every fork contributor would have
to discover the setting first. Waking the agent from the app's own merge detection
for every task: a larger change to the poller for the same effect.
