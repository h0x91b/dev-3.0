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
  is the fork and gets the branch. With several, the command stops and names
  `git config remote.pushDefault <fork-remote>` rather than guessing.
- **Fork head:** for a non-origin push, `gh pr create` gets `--repo <origin owner/repo>`
  and `--head <fork owner>:<branch>`, both parsed from `git remote get-url`.
- **Merge watch:** inside a task, after the PR opens, the CLI sends `pr.watch.add`
  with `until: "merged"` for the new PR number. The merge then reaches the agent
  first (`mergeOfferHeld`), and the protocol tells it to request completion. An
  unreachable app falls back to the old hint; `pr create` still works with dev3 closed.

## Risks

The single-other-remote rule could pick a remote that is not a fork (a mirror); it
only runs after `origin` refused, and the output names the remote it used. Every
task PR now wakes its agent once at merge.

## Alternatives considered

Only honouring `remote.pushDefault`: correct, but every fork contributor would have
to discover the setting first. Waking the agent from the app's own merge detection
for every task: a larger change to the poller for the same effect.
