# dev3 CLI allow rules and the Claude Code auto-mode classifier

## Context

An agent's `dev3 task move --status completed 2>&1 | tail -20; echo "EXIT=$?"` came back as
`Denied by auto mode classifier · Blocked by classifier`, which reads like dev3's permission
installation regressed. It had not: the worktree's `.claude/settings.local.json` carried
`permissions.defaultMode: "auto"` and `Bash(dev3:*)`, and `~/.claude/settings.json` carried
`Bash(~/.dev3.0/bin/dev3 *)`, both written by dev3 (`ensureDevPermission`, `applyClaudeSettings`).

## Investigation

Claude Code 2.1.266. Two documented facts explain the denial, and one was verified locally.

1. An allow rule must match **every** subcommand of a compound command; the recognized separators
   are `&&`, `||`, `;`, `|`, `|&`, `&` and newlines. Verified with an isolated fixture (a scratch
   `./myprog` plus `allow: ["Bash(./myprog *)"]`, manual mode, `claude -p`): the bare call ran, and
   the piped form was refused with `This Bash command contains multiple operations. The following
   part requires approval: tail -5; echo "EXIT=$?"`. Read-only built-ins do not fill that slot.
2. In auto mode the decision order is: rules resolve first, read-only actions next, **everything
   else goes to the classifier**. A compound the allow rule cannot cover therefore reaches the
   classifier with the whole command text, including the irreversible part.

The classifier also deliberately ignores `autoMode` in `.claude/settings.json` and
`.claude/settings.local.json`, so a project — dev3 included — cannot pre-clear it from worktree
scope. Only `~/.claude/settings.json` or managed settings can.

## Decision

`dev3BashPermissions()` in `src/shared/agent-hooks.ts` now returns one rule per spelling the agent
may type, and `ensureDevPermission` writes them all, so the worktree file is self-sufficient rather
than relying on the global file for the absolute-path form. Nothing was changed about the
classifier: a dev3 command wrapped in a pipeline still gets classified, and a completion still
needs the user's approval — which is the intended gate.

## Risks

The worktree file gains a second allow entry. Both entries are exact CLI prefixes, so no unrelated
executable becomes allowed, and an older dev3 build reading the same file just sees one more string.
It does not stop `Blocked by classifier` on compound dev3 calls — the cure for those is to run the
dev3 command on its own, or for the user to add an `autoMode.allow` entry to their own settings.

## Alternatives considered

Writing an `autoMode.allow` entry into `~/.claude/settings.json` from dev3 would actually silence
the classifier for lifecycle commands, but it loosens a safety gate in the user's global config for
every dev3 install — a product decision, not a bug fix. Leaving everything as it was is also
defensible, but then the absolute-path spelling dev3's own skills print stays covered only by a file
the worktree cannot see.
