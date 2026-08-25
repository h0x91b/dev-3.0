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

- **The readout's home is the overflow kebab; the bar slot is earned per occasion.** The labelled
  kebab row is always present. The bar pill (`variant="bar"`) renders immediately right of the three
  dots only while messages landed since the user's last look, and retires when they look — an unread
  badge, not a counter. It does **not** spend the header's one permanent ambient slot, which stays
  memory headroom. **Never on the bar at narrow width**: the phone header holds a breadcrumb and one
  kebab, so the labelled sheet row is the only mobile entry.
- **Unread is measured against the user's own last look** (`dev3-agent-traffic-seen`, localStorage,
  per browser). A first-ever look stamps itself, so a fresh install never opens on a badge of 400;
  the badge caps at `9+`. The pill deliberately outlives its own badge while its panel is open.
- **A pair row navigates to the receiver** of the newest message — the task that owes an answer, and
  the same click target the toast uses. The panel is not filtered by recency.
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
- **Unread state is per browser, not per user.** Reading the traffic on the desktop leaves the
  phone's badge lit, and vice versa. Correct for a "have *I* seen this on *this* screen" signal, but
  it will surprise anyone who expects the two to agree.
- **A cleared badge is unrecoverable except through the log.** Opening the panel marks everything
  seen, including rows the user scrolled past without reading; the log is the recourse.
- **The pair key uses task ids** — a message whose sender task was deleted keeps its own pair rather
  than merging into a peer's. Acceptable: the row is history, not state.

## Alternatives considered

- **A permanent header counter** (the memory-pill shape): rejected — it reads "0" on most boards
  forever, and the manifest's own anti-pattern list is header button creep.
- **A recency-based glyph** (present while a pair spoke in the last hour) shipped first and was
  rejected on sight of it running: it still puts a number in the header of an idle board, it lights
  up for traffic the user already read, and it goes dark on traffic they have not — recency and
  unread are simply different questions.
- **A ninth nav destination for the log**: rejected — the destination budget is spent, and this is a
  surface you open to answer one question, not a place you work in.
- **Inserting the pushed preview straight into the log**: rejected — it puts a shorter, statusless
  copy of a message next to the real row, and "unproven delivery" would be invisible.
- **Keeping the concept mocks' blocker filter** with a heuristic (e.g. treat `not-delivered` as a
  blocker, keyword-match the body): rejected as inventing data. A sender-declared importance flag
  would need a `dev3 message` CLI change, which is its own decision.
