# The squash-merge subject comes from the branch's commits or the task title, never the description

## Context

dev3's own Merge button squash-merges a task branch into the base branch and commits with
`git commit -F <file>`. The file held `task.title` — and `task.title` is
`titleFromDescription(description)` (`src/shared/types.ts`), the first 80 characters of the task
DESCRIPTION with a `…` appended, whenever nobody renamed the task. So a prose brief, often
Russian, often carrying backticks, became a permanent commit subject cut mid-sentence.

Reported from the rts-dots2 board (`da4fb07`) and corroborated here: 87 subjects on this repo's
`origin/main` contain `…`, 86 of them truncated briefs — e.g. `8f6fd84`,
`"если мы в проекте что уже в спейсе каком-то то дефолт вью должен…"`. None of the 86 carry the
`(#NNNN)` suffix GitHub's squash merge appends, which is what points at dev3's own path rather
than GitHub's.

## Investigation

One construction site, `writeMergeCommitMessage` (`src/bun/git-op-script.ts`), one caller,
`mergeTask` (`src/bun/rpc-handlers/git-operations.ts`). No truncation happens at merge time — the
title arrives already truncated from task creation (`data.createTask`, `updateTaskDescription`,
and the CLI's `task update`). The PR path is unaffected: it hands the merge to GitHub.

**The diagnostic for telling the two merge paths apart** (the rts-dots2 coordinator's, verified in
code here): GitHub's squash merge appends `(#NNNN)` to the subject, dev3's local squash does not.
A subject with no `(#NNNN)` came from `mergeTask`; one with it came from GitHub. Use that first
when a bad subject shows up on a base branch.

`titleFromDescription` is worth reading before trusting the ellipsis as a marker: every truncating
branch of it appends `…`, including the word-boundary one, so a trailing ellipsis is an EXACT
marker of "this string is a derived fragment", not a symptom test. A description shorter than the
limit becomes the title verbatim with no marker — so a short prose sentence is indistinguishable
from a deliberate title, by construction.

Three couplings that make that gate trustworthy rather than lucky, and that the next editor of
`titleFromDescription` needs to see:

- The marker is exact **by construction of that function**. A new truncating path that does not
  append `…` makes the merge gate leak silently, with no test failing.
- All three call sites pass the default limit of 80 — `data.ts:877`, `rpc-handlers/task-lifecycle.ts:726`,
  `cli-socket-server.ts:683`. A fourth call site with a different limit does not break the marker,
  but it does mean "80 characters" stops describing what a truncated title is.
- A human-written title that legitimately ends in an ellipsis is misread as derived. The
  consequence is that the subject falls back to the first commit's subject, which is a good
  subject anyway, so the failure mode is benign.

Two deterministic sources were already on disk and unused: the branch's own commit messages, and
the task title, which the agent protocol already asks agents to set as a concise imperative.

## Decision

`buildMergeCommitMessage` (`src/bun/git-op-script.ts`), fed by
`git.listBranchCommitMessages(worktreePath, baseRef)` (`git log --reverse --no-merges --format=%B%x00`):

- exactly one commit on the branch → reuse its message verbatim, subject and body;
- several → the task title is the subject, the commit subjects become a `- …` body;
- a title that is not subject-shaped — empty, a `Scratch — HH:MM` placeholder, or ending in `…`
  / `...` — falls back to the first commit's subject;
- a title over 72 characters yields to a commit subject when one exists, and is used **in full**
  when none does. Nothing is ever truncated: truncation is the defect.
- neither a commit nor a usable title → `Merge <branch>`;
- only the first line of a title is ever considered, so no newline can reach a subject.

No model is involved anywhere on this path, by requirement. Existing history is untouched — this
is a forward fix.

## Risks

The task title is user-owned and unchanged by this work, so a multi-commit branch under a title
nobody improved still gets a mediocre (but whole, un-ellipsised) subject. A branch whose only
commit is a merge commit reads as zero commits and falls back to the title. `--no-merges` drops an
integration merge's message from the body, which is deliberate but does mean a body can be shorter
than the branch's commit count.

## Alternatives considered

- **Truncate more carefully** (word boundary, no ellipsis) — still a description fragment; the
  source is the problem, not the cut.
- **Generate the subject with a model** — explicitly forbidden for this task, and unnecessary once
  the branch's own commits are read.
- **Fix `titleFromDescription`** — titles are partly user-owned and shown all over the UI; changing
  their semantics to make a commit subject nicer is the wrong lever.
- **Rewrite the 86 bad subjects on main** — history rewriting, far more dangerous than the defect.
- **Refuse a short prose title too** — a description under 80 characters becomes the title verbatim
  and passes the shape gate, so "Так, баг. Я в проекте, где нету origin никакого" can become a
  subject. The path to it is narrow: a single-commit branch never consults the title at all, so
  this needs a multi-commit branch that nobody retitled. **Refused, not merely tolerated:**
  separating prose from an imperative requires a model, a model is forbidden here, and therefore
  passing the user's own complete words through is the only honest option left — and strictly
  better than mutilating them. A future reviewer proposing a prose-detection heuristic is
  re-opening a closed decision.
- **Change `titleFromDescription` instead (fix the title, not the subject)** — refused as out of
  bounds, not overlooked. It would rewrite task titles product-wide, which is a user-visible change
  with its own blast radius and its own approval; a merge-subject fix does not get to do that on
  the way past.
