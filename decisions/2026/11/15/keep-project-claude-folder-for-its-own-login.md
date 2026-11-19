# Keep the project's Claude folder for the account it is signed in to

## Context
A project can pin its own Claude folder (`CLAUDE_CONFIG_DIR`). Explicitly picking a managed Claude account used to always switch to that account's own folder, so the task lost the project's rules, skills, memory and status line, even when the pinned folder was signed in to that same account.

## Decision
`claudeLaunchKeepsProjectFolder` (`src/bun/agents.ts`) keeps the pinned folder when it is signed in to the picked subscription account (`claudeAccountSignedIntoDir`: same `accountUuid` and org; API profiles never match). A fresh launch always keeps it. A resume keeps it only when the conversation is there: `--resume <id>` needs that transcript in the pinned folder, and `--continue` needs the pinned folder to hold this worktree's newest transcript. "Any transcript" was not enough, because a task that ran in the account folder would reopen an older conversation. A launch that kept the folder records no account on its pane (`projectLoginKept`), so a later resume looks in the project folder. The resume account guard (`assertAccountReachesPanes` in `resume.ts`) asks the same predicate, so it never refuses a switch the launch would accept.

## Risks
The match reads only the identity in `.claude.json`, not whether that folder's token still works, so a pinned folder whose session expired wins over a working account folder. Comparing newest transcripts by mtime trusts filesystem timestamps.

## Alternatives considered
Always switch folders, the old behaviour, which loses the project setup. Copying the account's credentials into the project folder would write into a folder the user owns. A user toggle per account would add a control for something the identity already answers.
