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

Two parts.

1. `dev3BashPermissions()` in `src/shared/agent-hooks.ts` returns one rule per spelling the agent
   may type, and `ensureDevPermission` writes them all, so the worktree file is self-sufficient
   rather than relying on the global file for the absolute-path form.
2. `applyClaudeSettings` in `src/bun/agent-skills.ts` declares `DEV3_AUTO_MODE_ALLOW_ENTRY` in
   `autoMode.allow` in `~/.claude/settings.json`, next to the `permissions.allow` rule and the
   socket allow-list it already wrote there. The entry is prose, names only the dev3 CLI, and says
   what the classifier cannot know: `dev3 task move` is a request to the running app, the app gates
   completion with its own dialog the user clicks, and the worktree it removes is disposable task
   scratch. `"$defaults"` is spliced in when the list is empty, never when the user owns a list
   without it.

The app's own process writes that file, which is what makes part 2 possible at all: an agent cannot
write it — verified — because the classifier blocks an agent editing its own auto-mode config, and
an explicit user instruction does not clear that block.

## Risks

`autoMode.allow` is a safety gate in the user's global config, and dev3 now widens it without being
asked per install. The entry is scoped to the `dev3` CLI and clears nothing else on the command
line, the completion approval dialog is untouched, and `soft_deny`/`hard_deny` and `environment`
stay as the user left them — but this is a real loosening, not bookkeeping. A classifier that stops
honouring the entry brings the denials straight back, with no signal other than the denial itself.
The worktree file gains a second allow entry. Both entries are exact CLI prefixes, so no unrelated
executable becomes allowed, and an older dev3 build reading the same file just sees one more string.
Neither part changes how a compound command is matched, so a dev3 call wrapped in a pipeline still
reaches the classifier — now with the exception in front of it. Running the dev3 command on its own
stays the cheaper habit, and the entry only takes effect in sessions started after it was written.

## Alternatives considered

Shipping only part 1 and leaving each user to write their own `autoMode` entry: correct on paper,
but the classifier cannot be reached from any scope dev3 controls, so every install would keep
hitting `Blocked by classifier` on its own lifecycle commands. Arseny made the call to have dev3
declare it. Replacing the whole built-in `allow` list instead of splicing `"$defaults"` was never on
the table — it silently discards the classifier's built-in exceptions.
