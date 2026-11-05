# Claude usage is attributed by CLAUDE_CONFIG_DIR, never by an inherited account id

## Context

Two managed Claude accounts (same email, two orgs) showed identical usage after "+ Agent → continue
conversation" put a second agent on the other account. The tmux session of a task is created with the
first launch's env (`CLAUDE_CONFIG_DIR` and `DEV3_AGENT_ACCOUNT_ID` of account A) and keeps it. The
spawned agent gets account B through its own launch script only. Claude Code agent-team teammates then
open panes that carry B's `CLAUDE_CONFIG_DIR` (Claude forwards it explicitly) but inherit A's
`DEV3_AGENT_ACCOUNT_ID` from the tmux session env. `dev3 statusline` trusted the account id, so B's
quota was written into A's dump.

## Investigation

Verified on a live machine: the teammate process env had `CLAUDE_CONFIG_DIR=<accounts>/claude/<B>` and
`DEV3_AGENT_ACCOUNT_ID=<A>`. `tmux show-environment` on the task session still held A, and A's dump
named a transcript under B's account dir. Account dirs and `.claude.json` identities were intact: the
handoff only retells the conversation and registers trust, it copies no credentials.

## Decision

`claudeDumpOwner` (`src/cli/commands/statusline.ts`) derives the owner from the config dir Claude
actually runs on: `<dev3Home>/agent-accounts/claude/<id>` is account `<id>`
(`managedClaudeAccountIdForConfigDir`, `src/shared/claude-config-dir.ts`). Any other pinned dir is a
config-dir login, and an unset dir is the system login. `DEV3_AGENT_ACCOUNT_ID` is deleted, because
nothing can keep a tmux-inherited copy of it honest. The monitor also remaps a config-dir dump that names
a managed account dir (`attributeManagedConfigDir`), so dumps an older CLI wrote still land on the right
account. Separately, Claude identities now carry `organizationId` (`organizationUuid`). Duplicate checks
and routing dedupe compare it, because one person in two orgs shares `accountUuid` and email, and org
names are not unique.

## Risks

A session whose `CLAUDE_CONFIG_DIR` names a symlinked or relocated account slot by a different path is
read as a plain pinned dir. Every dev3 launch uses `claudeAccountDir()` verbatim, so this only affects
hand-made launches.

## Alternatives considered

Rewriting the tmux session env on every agent spawn fixes the new agent's teammates but breaks the old
agent's, since one task can run panes on two accounts. Stripping account vars from the session env
leaves teammates with no account at all. Either way the pane env stays a second source of truth that
can drift from the credentials.
