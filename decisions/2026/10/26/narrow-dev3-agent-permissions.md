# Narrow the dev3 permissions injected into Claude Code

## Context

Issue #2043 (@shamrai-nikita) reported that the standing dev3 grants let an agent skip its own
permission check. Claude Code worktrees carried `Bash(dev3:*)` and `Bash(~/.dev3.0/bin/dev3 *)`.
An allow rule approves a call before the auto-mode classifier sees it, so
`dev3 pane run "<anything>"` ran unreviewed.

## Investigation

Confirmed on main (v1.61.0) from the code: `dev3BashPermissions` covered every subcommand,
including the internal `__pane-run` runner and `dev-server start`. A worktree's `.dev3/config.json`
is read first for own-branch tasks, so an agent can edit `devScript` and then start it.

The Codex half of the report was also confirmed, with `codex sandbox` 0.163 against a fake
`~/.dev3.0`: the `dev3` profile's `~/.dev3.0 = "write"` lets the sandbox write `bin/` and `data/`,
and the app socket stays reachable.

## Decision

- **Claude only** (`src/shared/agent-hooks.ts`):
  - `DEV3_AUTO_APPROVED_SUBCOMMANDS` holds metadata subcommands only.
  - Each spelling gets an exact rule and a `<sub> *` rule; the space is the word boundary.
  - `isBroadDev3Rule` removes the old whole-CLI rules from `settings.local.json` and from
    `~/.claude/settings.json` (`applyClaudeSettings`).
  - The classifier entry now says that a pane run's command and a dev script are judged as if run
    directly.
- **Codex: deliberately unchanged**, by the maintainer's call.
- **No app-side approval on `pane.run`**: the maintainer chose not to add one.

## Risks

- **Still open:** any process that reaches the app socket has the app's powers. A sandboxed agent
  can still call `pane.run` or `dev-server.start` and run something outside its sandbox. The Codex
  profile also still grants write on all of `~/.dev3.0`.
- Claude now asks (or the classifier judges) on `pane run`, `dev-server start`, `agent spawn`,
  `automations create/run` and the rest.
- Each settings file carries 152 rules instead of 2.

## Alternatives considered

An `ask` rule for `dev3 pane run` next to the broad allow fails open: `dev3 --instance x pane run`
and any new executing subcommand slip past it. An allowlist fails closed.
