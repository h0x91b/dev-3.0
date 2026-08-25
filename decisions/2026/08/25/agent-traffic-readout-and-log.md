# Agent traffic: a conditional header readout plus an overlay log

## Context

`dev3 message` between two tasks' agents had exactly one surface: a 30-second violet toast
(`toast.agent`, bible §5.7). The human's three questions — must I step in, did two tasks collide,
who waits on whom — are all answered *after the fact*, which a toast structurally cannot do.

The durable half already existed and had no reader at all: PR #1500 appends every delivery attempt
to `~/.dev3.0/data/<slug>/messages/YYYY-MM-DD.jsonl` (30-day retention, `readAgentMessageLog` RPC,
full body + delivery verdict). Nothing in the renderer called it. So this change is renderer-only —
no on-disk format, no delivery-path change.

## Investigation

Six display concepts were built and screenshotted first (throwaway gallery, `?msgconcepts=1`), and
the two the user picked are implemented here: a header switchboard and a traffic log.

The concept mocks carried an importance axis (chatter / normal / blocker) and it had to be dropped:
no sender can declare importance — the field does not exist in the payload, in the row, or in the
CLI. Rendering one would have been the UI asserting a fact it does not have. The row's own
`AgentPromptDeliveryStatus` turned out to be the honest replacement: "typed but never confirmed" is
exactly the case a human has to step into.

## Decision

- **The header readout is conditional** (`AgentTrafficIndicator`, `variant="bar"` returns `null`
  with no live pair). It does **not** spend the header's one permanent ambient slot, which stays
  memory headroom: machine capacity is useful on the happy path, silence between agents is not.
  The live window is 1 h (`LIVE_WINDOW_MS` in `src/mainview/agent-traffic.ts`).
- **The count is live pairs, not messages**, and a pair row navigates to the **receiver** of the
  newest message — the task that owes an answer, and the same click target the toast uses.
- **The log is an overlay, not a destination** (`AgentTrafficLog`): the nav budget is 8 and spent
  (bible §4), so it takes the task-notes-log shape — dialog on wide, BottomSheet on narrow.
  Entry points: the readout panel, `⇧⌘M` (`keymap.ts`), the View menu, the command palette.
- **A live arrival refetches instead of being inserted.** The push carries a clamped preview with
  no status; the row on disk carries the full body and the verdict. The refetch is debounced 400 ms
  and repeated at 2.5 s because the row is appended at the delivery *outcome* while the push fires
  as the text goes in, so a single read can legitimately miss it.

## Risks

- **Two reads per arrival.** A burst of messages coalesces into one debounce, but a steady stream
  costs one `readdir` + day-file read per ~400 ms. Bounded by the 500-row page and the fact that
  only day-files are opened.
- **The 1 h window is a guess.** Too short hides a slow conversation from the header; too long
  turns the glyph into permanent chrome. It is one constant, and the log is unaffected either way.
- **The pair key uses task ids** — a message whose sender task was deleted keeps its own pair rather
  than merging into a peer's. Acceptable: the row is history, not state.

## Alternatives considered

- **A permanent header counter** (the memory-pill shape): rejected — it reads "0" on most boards
  forever, and the manifest's own anti-pattern list is header button creep.
- **A ninth nav destination for the log**: rejected — the destination budget is spent, and this is a
  surface you open to answer one question, not a place you work in.
- **Inserting the pushed preview straight into the log**: rejected — it puts a shorter, statusless
  copy of a message next to the real row, and "unproven delivery" would be invisible.
- **Keeping the concept mocks' blocker filter** with a heuristic (e.g. treat `not-delivered` as a
  blocker, keyword-match the body): rejected as inventing data. A sender-declared importance flag
  would need a `dev3 message` CLI change, which is its own decision.
