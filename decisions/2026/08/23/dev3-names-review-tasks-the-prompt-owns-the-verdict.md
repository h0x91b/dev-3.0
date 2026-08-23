# dev3 drafts a review task's name; the agent owns the final one

## Context

Every PR-review card on the board read the same thing: `Review the code changes
on this branch. Your task is to perform a thorough…`. A review task's description
leads with the PR-review preset preamble (`DEFAULT_PR_REVIEW_PROMPT`), the user
usually adds no text of their own, and `titleFromDescription` then truncates that
shared preamble at 80 characters. N review tasks therefore produced N identical
titles, differing only in the `#493` PR badge beside them. The overview was
whatever the reviewing agent happened to write, or empty.

## Investigation

The obvious fix is to put the naming rule in the prompt and let the agent rename
itself. The prompt is overridable at two levels — project `reviewModePrompt`, then
global `reviewModePrompt`, then the built-in (`resolvePresetPrompt`) — so a rule
that lives only in the prompt silently skips every user who already customised it,
and those are exactly the users most likely to run many reviews. It also leaves
the card anonymous until the agent gets round to renaming.

dev3 already knows enough to name the task at creation. `findOpenPullRequest`
(`gh pr list --head`) was one `--json` field list away from returning the PR title
and author, and a branch with no pull request still has a commit tip whose `%an`
and `%s` name its author and its subject.

The verdict half is different in kind: no merge verdict and no finding counts
exist before the review runs, so only the agent can write them. That half has to
live in the prompt, and an overridden prompt genuinely misses it.

## Decision

**Both surfaces, and the agent is the author of the final text on both.** dev3
only fills the gap between creation and the agent's first free moment.

- **Title — dev3 drafts it at creation, the agent replaces it.**
  `reviewTaskTitle` / `reviewTitleTopic` (`src/shared/types.ts`) compose
  `Review of #493 from <author> about <five words>` out of the pull request's own
  title; `reviewTitleForBranch` in `src/bun/rpc-handlers/task-lifecycle.ts`
  gathers the parts and `createTask` writes the result as `Task.title`.
  `DEFAULT_PR_REVIEW_PROMPT` spells out the same shape and tells the agent to set
  it itself with `dev3 task update --title`, calling dev3's version a draft: dev3
  can only repeat what the PR title claimed, while the agent has read the diff.
  dev3 writes `title`, never `customTitle` and never `titleEditedByUser`, so the
  user-edited title protection is untouched — a title the user typed still wins
  through `getTaskTitle`, and the agent's own rename still works.
- **Overview — the prompt only.** `dev3 overview set "<verdict>. <counts>"`,
  verdict out of `Safe to merge` / `Merge after fixes` / `Do not merge`, counts as
  numbers, under 500 characters. No verdict exists before the review runs, so
  there is nothing for dev3 to draft here.

Supporting extractions, each used by both its old and new caller rather than
duplicated: `git.localBranchNameForRef` (the `refs/remotes/<ref>` rule that
`createWorktree` had inline) and `git.refAuthorAndSubject`.

## Risks

- A user with an overridden review prompt gets the good title and no verdict
  overview. Unavoidable: the verdict cannot be produced anywhere but the agent.
  The override surfaces show the built-in text to diff against.
- Creating a review task now waits on one `gh pr list` (15 s cap) plus one
  `git log`. Both failures are caught and fall back to today's derived title.
- `gh pr list --head <branch>` is unreliable for cross-repo (fork) pull requests,
  so a fork review may fall back to `Review of <branch> from <commit author>
  about <commit subject>` instead of the PR number. Still distinguishable, and
  the PR badge on the card still appears once the identity poll matches it.
- The Create Task modal still previews no title for a review task with no text of
  the user's own; the composed title appears on the card after creation. The
  modal would need its own PR lookup to preview it.

## Alternatives considered

- **Prompt only.** Costs nothing, but misses overridden prompts and leaves the
  card anonymous for the first minutes.
- **dev3 only.** Deterministic and immediate, but no verdict overview at all, and
  the "about" clause would forever be the PR author's own wording rather than what
  a reviewer found in the diff. Rejected explicitly by the user: naming the task
  is the agent's job too, dev3's version is a first draft.
- **Composing the title in the renderer**, where the Create Task modal already
  derives `generatedTitle`. Rejected: the modal has the branch but not the PR
  author, only one of the two branch-picking paths has resolved the PR, and a
  second composer on the bun side would have been needed anyway.
