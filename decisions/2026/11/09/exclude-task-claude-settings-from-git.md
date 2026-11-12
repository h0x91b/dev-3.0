# Keep dev3's task `.claude/settings.local.json` out of git status

## Context

Every Claude task gets dev3's hooks and approvals in `<task>/.claude/settings.local.json` (`writeClaudeHooks`, `src/shared/agent-hooks.ts`). In a repo that does not ignore the file, `git ls-files --others --exclude-standard` lists it, so `getUncommittedChanges` reports work that the user never made: `mergeCompletionBlocker` then withholds the merge-completion offer ("Uncommitted changes in the worktree", visible only on a manual refresh), and Complete warns about uncommitted changes.

## Decision

After writing the hooks (launch, `src/bun/agent-hooks.ts`; and the pre-prompt refresh, `src/bun/agent-hooks-refresh.ts`) dev3 calls `excludeTaskClaudeSettings` (`src/bun/claude-config-git.ts`), which appends `/<prefix>.claude/settings.local.json` to the repo's `info/exclude`, the same never-committed file the pinned-config-dir rules already use (both go through `addExcludeRules`). It does nothing when the repo tracks the file or the folder is not a git repo.

## Risks

A linked worktree's `info/exclude` is the main repository's, so the rule also hides an untracked `.claude/settings.local.json` in the main checkout. That file is Claude's per-machine settings, which is meant to stay local, so hiding it is the expected outcome. Other untracked files under `.claude/` stay visible.

## Alternatives considered

- Ignoring `.claude/` when counting uncommitted work: it would also hide a user's real new agent or command files.
- Writing the hooks through `--settings` only: already done for dev3-owned folders, but a git task keeps the file so the user's own approvals survive restarts.
