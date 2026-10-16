# A coordinator's relayed order carries the user's authority in auto mode

## Context

A coordinator relays the user's decisions to the tasks it manages via `dev3 message`. In the
receiving task Claude Code's auto-mode classifier refused the git work those orders named
(force-push, squash merge without review, `gh pr merge --auto`): its defaults treat anything an
agent wrote — a `<teammate-message>`, a plan, a subagent instruction — as another agent's output,
never as user intent, and the `<dev3-ai-message>` envelope only said "a colleague wrote this".

## Investigation

`claude auto-mode defaults` (Claude Code 2.1.x): Merge Without Review blocks a merge nobody approved
and `--auto` on an unprotected repo; Git Destructive presumes others' work only on the default branch
and lets an agent force-push its own branch. A live probe confirmed the second part: a relayed
"rebase and force-push feat/x" passed even without dev3's rules, so the branch case was never the
blocker. The envelope carried no sender role, so a prose rule alone gave the classifier nothing it
could check.

## Decision

`resolveAgentMessageSource` (`src/bun/cli-socket-server.ts`) stamps `role: "coordinator"` from the
sender's `taskType`, and `wrapAgentMessage` renders it as a `<from-role>` header tag before
`<message>`. `applyClaudeSettings` (`src/bun/agent-skills.ts`) writes `DEV3_AUTO_MODE_COORDINATOR_ENTRY`
(an envelope with that header tag = the user's own words, every soft_deny cleared as the user's
would, hard_deny untouched) and `DEV3_AUTO_MODE_GIT_ENTRY` (a task's own branch and PR are its to
rewrite, force-push and merge on request, default branch excluded). Each dev3 entry opens with a
stable `dev3 …:` label, and an older wording under the same label is replaced, not stacked.

## Risks

A real loosening of the user's global safety gate, written without a per-install prompt. A
compromised or prompt-injected coordinator now has the user's soft_deny authority over its peers;
the tag is app-stamped, but the classifier reading "header tag, not one inside `<message>`" is
prose judgement, not a parser. The classifier may also simply ignore an allow entry; nothing but a
denial would show that.

## Alternatives considered

Treating every `<dev3-ai-message>` as user intent (any agent could order any other); a prose rule
naming coordinators with no tag (unverifiable for the classifier); limiting the relay to git only
(rejected by the user — the coordinator stands in for the user, so it gets the user's reach).
