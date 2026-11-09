# Coordinator brief follows the repo's git flow; cap raised to 6 700

## Context
`COORDINATOR_PROMPT` ships to every install, but three clauses hard-coded one flow: GitHub pull requests into `main`, rebase to integrate, and CI as the proof of done ("the second to land rebases", "picked up by rebase", "merged PR, CI green on its SHA"). On a gitflow repo (features into `develop`, hotfixes from `main`), a GitLab or merge-commit repo, a fork with its own integration branch, or a repo with no CI, the coordinator either misreports done or briefs children against the wrong branch.

## Decision
The brief now defers to the repo: a `FOLLOW THE REPO'S FLOW` rule points at the repo's docs or the user for branches, PR or direct merge and required checks, forbids assuming `main`, GitHub or CI, and names `--branch <ref>` for a base other than the project's. The child brief template gains "target branch". Done is "merged to its target, required checks green on its SHA"; the integrate verb is "syncs". `preset-prompt.test.ts` fails if `rebase`, `merged PR` or `CI green` comes back.

## Risks
`COORDINATOR_PROMPT_LIMIT` in `src/shared/agent-command-line-budget.ts` goes from 6 500 to 6 700, so a coordinator task on Windows keeps 200 fewer characters of description room (gemini 26 037, custom 26 026; floors 26 000 / 25 990 in `agent-command-line-budget.test.ts`). An existing Settings or project override keeps its own wording.

## Alternatives considered
Trimming other rules to pay for the change: every remaining clause is pinned by a test written after a real coordinator failure, so cutting them trades one known failure for another. A per-project flow setting: a second place to describe the flow that AGENTS.md or CONTRIBUTING already describes.
