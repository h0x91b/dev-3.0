# Resume on another Claude account

## Context

A resume always relaunched each pane on its saved account, so a task stuck on an exhausted login could only move by hand-editing `tasks.json`. Claude account dirs symlink `projects/` and `sessions/` to `~/.claude` (`scaffoldClaudeAccountDir`), so another account can usually open the same conversation; verified by hand-switching two hibernated coordinators, which resumed with their full history.

## Decision

`ResumeTaskOptions.accountId` (`src/bun/rpc-handlers/tmux-pty/resume.ts`) overrides the account of every Claude pane for one resume and pins it on the task, so Start Fresh and reconnect follow. It is offered on the wake/recovery screen and in the resume approval dialog (`ResumeAccountPicker`, reusing the per-launch `AgentAccountIndicator`), and as `--account <id|system>` on `dev3 agent resume` / `dev3 task wake --resume`. The dialog's pick travels back in `AgentLaunchChoice.resumeAccountId`, so an auto-approval uses it too. Before anything wakes, `assertAccountReachesPanes` refuses an unknown or signed-out account, `auto`, a task with no Claude pane, an account whose config dir has no transcript for a saved conversation (`claudeConfigDirHasSession`), and a Claude pane with no conversation id, whose `--continue` would open the other account's latest — exit 32 with `account-invalid` / `account-cannot-see-conversation`. `dev3 agent resume` runs the account-only checks (`assertResumeAccountUsable`) before it opens the approval dialog, and again on the dialog's pick after approval, so nobody approves a resume that cannot happen. Re-picking the account a pane already runs on is not a switch. On the native backend only the main pane is judged, since only it relaunches; a resume already in flight refuses a caller with an account instead of letting it join and drop the pick.

## Risks

Only Claude moves. A Codex conversation lives in its account's own `CODEX_HOME` and resume locates it by session id (`codexAccountIdForHome` wins over any requested account), so moving it would lose the conversation; Codex panes are left alone and the picker says so. An account created by an older build may hold a real `projects/` dir and cannot see shared history; the transcript check refuses it rather than letting Claude start an empty conversation. A preset that pins `CLAUDE_CONFIG_DIR` in its own env still bypasses account injection, as on launch.

## Alternatives considered

Offering Auto: resume launches never route (`autoRouting` is only built for fresh launches), so "auto" would silently mean the default account; the picker hides it (`allowAuto={false}`) and the backend refuses it. Copying transcripts between account dirs would let Codex move too, but it rewrites state other installed versions read and was rejected under the on-disk invariants. A card-level "Change account" action was rejected: an account is chosen at launch, and a resume is a launch.
