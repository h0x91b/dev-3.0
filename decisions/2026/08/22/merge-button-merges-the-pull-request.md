# Merge merges the pull request when there is one

## Context

`git-bar-actions-follow-repo-state.md` made Merge push the base branch after the
local squash, so the work would actually reach origin. Used on a task that had an
open PR, that is the wrong operation entirely: it squashes into the user's local
`main`, pushes it straight to origin, and bypasses the PR's own review and CI. On
this repo it also fails at the last step — `main` is protected — leaving a stray
squash commit on the local branch and a pane that says "did NOT reach origin".

The expectation the button set was "merge my PR". It should do that.

## Decision

`mergeTask` (`src/bun/rpc-handlers/git-operations.ts`) now picks a route from repo
state, exactly like Push picks between a plain and a leased push:

| Repo state | What Merge does |
|---|---|
| An open PR for this branch | `gh pr merge <N> --<method>` (`mergeViaPullRequest`) |
| No PR, remote present | local squash + `git push origin <base>`, behind a confirm |
| No remote | local squash, no ceremony |

- The PR route is **not** a pane script. `gh pr merge` is one API call with a
  one-line output, so there is nothing to watch live, and a pane cannot carry the
  project's gh credential without the bash-only `getGitHubShellExports` prelude
  that keeps `openPullRequest` off Windows. It still pushes `gitOpCompleted` so the
  status refresh and the "task done?" offer behave identically.
- The merge method is resolved from `gh repo view` (`resolveMergeMethod`,
  preference squash → merge commit → rebase). `gh pr merge` with no method flag
  **prompts** when several are allowed, which in a headless call is a hang.
- No `--delete-branch`: the head branch is checked out in the task's worktree, so
  gh's local delete would fail *after* the merge succeeded and report the whole
  operation as failed. dev3 removes worktree and branch on task completion.
- `expectRoute` travels with the request. The button already told the user which
  route it would take, so a mismatch is refused rather than silently running the
  other one — a local squash-and-push behind a "merge the PR" confirmation is the
  worst outcome available here.
- The PR route ignores `behind > 0`: mergeability is GitHub's judgement. The local
  route keeps the rebase gate, because it commits the base branch itself.
- `github.findOpenPullRequest` is now the single `gh pr list --head` call, shared
  by branch-status PR detection and this route.

## Risks

- `gh pr merge` failures reach the user as a toast carrying gh's own message
  ("not mergeable", "review required", "checks are pending") — informative, but no
  longer a live pane. Accepted: there was never any live output to lose.
- A repo whose only allowed method is one gh rejects (e.g. squash disabled and the
  read failed) produces a clear gh error rather than a fallback attempt.
- `expectRoute` can refuse a click on stale status; the fix is the refresh button,
  and the message says so.

## Alternatives considered

- **Always merge via PR, creating one first when absent.** Turns one click into an
  agent handoff plus a wait; the local squash is the right answer for a repo with
  no remote or no forge.
- **A separate "Merge PR" button.** Two buttons for one intent, and button creep in
  the row the UX bible already calls out.
- **Keep the pane and shell out to gh there.** Needs the bash-only auth prelude,
  which is why `openPullRequest` still refuses to run on Windows.
- **`--admin` to force past pending checks.** Silently defeats the gates that make
  this route the correct one.
