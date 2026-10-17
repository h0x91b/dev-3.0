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

Follow-up the same day, from two cross-board audits (Base44, video-edit): the relay is scoped — it
clears only the operation, targets, limits and addressee it states, and a relay naming no concrete
operation clears nothing. The git entry also says that creating a new ref at an exact SHA, an
expected-absent `--force-with-lease=<ref>:`, and a non-force landing on the default branch are an
ordinary push, not Modify Shared Resources (which counts "creating new resources in shared
namespaces" and beat the built-in Git Push Destination exception on both audited pushes). The
coordinator brief (`COORDINATOR_PROMPT`, `src/shared/types/prompts.ts`) used to say "PERMISSION DOES
NOT TRAVEL … your relay authorises nothing", which made children refuse relayed grants on their
own; it is reversed to "RELAYED PERMISSION IS SCOPED AND SPENT WHEN USED", telling the coordinator to
relay the user's words verbatim with operation, targets, limits and the child's seq.

Second follow-up, 2026-10-17: with these entries already installed, a review task's merge of the
PR it reviewed was still refused as Merge Without Review after the user typed "мёржи" — the git
entry only covered the task's OWN PR, and the default rule wants the user to say "without review".
The entry now says a merge the user orders in their own turn, of the PR under discussion, is the
human approval, and that a non-forced `git switch`/`git checkout <ref>` is not local destruction.

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
