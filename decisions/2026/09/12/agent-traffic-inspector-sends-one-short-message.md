# Agent traffic gets a one-message composer, reversing "no composer"

## Context

`PRODUCT_UX_BIBLE.md` §5.9 ended with "no composer, terminal, import/export or synthetic
queue", and `ux-architecture.yaml` listed `send_message` under the traffic screen's
`forbidden`. The screen is where the user sees a task stall, ask a question, or go quiet —
and the only way to answer was to leave the screen, open the task and lose the map. The
user asked for a compact composer there.

## Investigation

The app already has exactly one user→agent delivery path that is provably the user's own:
`sendAgentMessageNow` (`src/bun/rpc-handlers/pr-comments.ts`), which calls
`sendMessageImmediately(..., { hold: false, origin: "user" })`. `origin: "user"` is what
makes `traffic-model.ts` draw the row from the `You` endpoint instead of inventing a peer
sender, so reusing this handler is what keeps the new rows honest. The CLI's
`message.send` is the other caller and it sets `sourceTaskId` — agent traffic. Nothing
else in the codebase can claim user origin.

`sendMessageImmediately` already refuses a terminal-status task and throws when no live
pane exists, so "no silent launch" needs no new backend rule — only a UI that reports the
refusal instead of swallowing it.

## Decision

`src/mainview/components/agent-traffic/TrafficComposer.tsx`, rendered inside the task
inspector of `AgentTrafficScreen.tsx` under `Open task`. It sends through the existing
`sendAgentMessageNow` RPC with the selected node's own `id` + `projectId`, so a task from
another project (or one variant of a group) is addressed correctly under
"All active projects". Drafts and send verdicts are held by the screen, keyed by node key,
so switching selection loses neither. Modifier-Enter sends and plain Enter is a newline —
the house convention from `TerminalComposer` and `ScheduleMessageModal`. `Open task` keeps
the accent fill; Send is a neutral solid, so the screen still has one primary.

`hold: false` is inherited from the handler and is right here for a different reason than
the diff viewer's: the user is on the traffic screen, not typing in that pane, so the hold's
"never land mid-line" purpose does not apply, and an immediate send is what makes the
attempt show up on the map they are looking at.

Manifest updated in the same change: bible §5.9 (the rule sits inside the "Inspect before
navigating" bullet, not as a tenth one) and the §4 surface table, yaml
`agent_traffic_screen.allowed`/`forbidden`/`note`. **No budget was ratcheted** — all three
files sit at or below where `main` had them (bible −2 bytes, yaml −48, log +36 with 24 to
spare), paid for by rewrapping §5.9's bullets to one line each and tightening its wording with
every claim kept, plus two record-backed folds. `src/bun/__tests__/ux-docs-budget.test.ts`
carries the accounting and names the three clauses that were deliberately not cut.

The shortcut the composer advertises (⌘/Ctrl+Enter) is deliberately NOT in `keymap.ts`: that
registry is for APP-LEVEL shortcuts, and this is a control-local handler that fires only while
its own textarea has focus — the same shape as `TerminalComposer` and the mobile docked
composer, neither of which is registered. The only registered Enter binding is `pane-zoom`
(⇧⌘Enter), which does not collide.

## Risks

- The screen can now write, not only read. Bounded by: one selected task, 1000 chars, no
  slash commands, no completion, no file drop, no launch or resume.
- A send that fails while the user has already selected another node reports only on
  return. Accepted: the screen's own message list records the failed attempt as a row,
  which is the more durable evidence anyway.
- `runtimeState` is a hint, so the "no session running" line can be wrong in both
  directions. It therefore warns and never disables — the send itself is the authority.

## Alternatives considered

- **Leave it forbidden, keep `Open task` the only write path.** Rejected: the user asked
  for the composer, and the round trip through the task screen is the cost the traffic map
  exists to avoid.
- **A full terminal composer in the inspector.** Rejected explicitly by the request and by
  the 340px inspector: a terminal belongs to the task screen.
- **Fabricate a peer-agent envelope so the message looks like coordinator traffic.**
  Rejected outright — it would put words in an agent's mouth in a log whose whole claim is
  that it records real attempts.
- **Toasts for the result instead of an inline status.** Rejected: the toast would click
  through to another project's task and is easy to miss; the inspector is where the user is
  looking.
