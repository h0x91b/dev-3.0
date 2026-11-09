# Gitless projects get their own built-in coordinator brief

## Context
`COORDINATOR_PROMPT` assumed the git workflow in three clauses: "Same-file overlap needs no traffic: the second to land rebases", shared wording "picked up by rebase", and done as "merged PR, CI green on its SHA". A project with the git workflow off runs every task in one folder. There is no rebase there, the second writer overwrites the first, and done is a commit. The mismatch showed up on a real gitless board.

## Decision
`coordinatorPrompt(gitWorkflow)` in `src/shared/types/prompts.ts` builds both texts from one template, so the shared rules cannot drift. `GITLESS_COORDINATOR_PROMPT` tells the coordinator to sequence same-file work, drops the rebase clause, and accepts a commit (or saved files when the folder has no git) as the artefact. `builtinCoordinatorPrompt(project)` picks the text by `hasGitWorkflow`, and `presetPromptForTaskType` uses it, so task creation, `dev3 task update --type` and `--print-role` all agree. Both texts stay under `COORDINATOR_PROMPT_LIMIT`.

## Risks
A project or Settings override replaces either text whole, so a custom prompt written for git projects still says "rebase" on a gitless board. A To Do coordinator task created before its project's switch flipped keeps the old built-in text, and `--type standard` then leaves that preamble in place (the documented no-match behaviour of `withoutPresetPrompt`). Virtual boards also get the gitless text: they have no branches either, and the "Shared folder" wording holds only when an Operations task uses a fixed folder.

## Alternatives considered
One text with both cases spelled out: longer for every coordinator and asks the agent to work out which board it is on. A separate gitless setting field: a second override for users to keep in step, for a three-clause difference.
