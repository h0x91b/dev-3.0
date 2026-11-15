# A pane remembers it ran on the project folder's own login

## Context
A task whose picked Claude account is the login the project's pinned Claude folder is already signed in to keeps that folder (`projectLoginKept`) and records no `accountId` on its pane. A launch that names a login also unsets the project env's backend keys (`CLAUDE_CODE_USE_BEDROCK`, credentials, model ids). On resume the pane had no account, so the launch looked like "no pick" and the project's Bedrock switch came back.

## Decision
The pane stores `projectLogin: true` (`PaneSessionEntry`, written in `task-launch.ts`, `agent-spawn.ts`, `resume.ts`). Resume passes it as `CommandOptions.projectLogin`; `resolveLaunchAccount` (`src/bun/agents.ts`) then returns `projectLoginKept` + `namesLogin` for a pinned project with no explicit account, and `applyProjectClaudeEnv` drops the backend env exactly as at launch.

## Risks
The flag is trusted even if the project folder later signs in to someone else; the session still runs in that folder, only without the project backend env. Older app versions ignore the field and resume as before (additive, on-disk safe).

## Alternatives considered
Recording the `accountId` on the pane: rejected, a resume would re-check the folder's login and switch folders (losing the conversation) when it changed, and #2293 deliberately records no account. Deriving it on resume from the folder's current login: rejected, it would also turn a no-pick launch into a named one after a resume.
