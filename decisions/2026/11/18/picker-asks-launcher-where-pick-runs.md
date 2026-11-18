# The account picker asks the launcher where each pick runs

## Context
Three places answered "which Claude folder and env does this pick launch with": the launcher (`resolveLaunchAccount` in `src/bun/agents.ts`), the resume guard (`resume.ts`), and the account picker (`AgentAccountIndicator`). The first two share `claudeLaunchKeepsProjectFolder`. The picker re-derived the answer from login identities and the project env's backend keys. On a resume it ignored where the conversation lives, so an account signed in to the project's folder said "Runs in this project's Claude folder" even when the resume would open its own folder.

## Decision
The picker asks `getClaudePickLaunches` (`src/bun/rpc-handlers/agent-accounts.ts`). For no pick, the system login and each managed Claude account it returns whether the session runs in the project's pinned folder and which project backend reaches it. Each row comes from `resolveClaudePickLaunch`, which runs `resolveLaunchAccount` itself, without auto-routing, so no pick is reserved. A resume passes its task and saved conversation id, and the handler builds the launch the way `resume.ts` does: the task's worktree, its launch project's env and `rootProjectFor`.

The picker folds an account into the project row only when its answer equals the no-pick answer. Until the answer arrives, and on a resume with no known task, nothing folds and no row claims a folder. The resume picker never folds: there the project row keeps each pane's saved account, so it is not the project folder's launch. `getProjectClaudeLogin` lost its `backend` field, which only the picker read.

## Risks
One more RPC on each open of a launch or resume dialog with a pinned project. It reads a few small files per account and starts nothing. The folder notes appear a moment after the rows.

## Alternatives considered
Sending the picker the identities and the transcript times so it can decide: rejected, it is a fourth copy of the rule and goes stale the next time the launcher changes. Folding on a resume when the answers match: rejected, the resume picker's project row means "keep the saved account", which can run anywhere.
