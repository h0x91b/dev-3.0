# Replay cards read the historical projection at render time

The pure projection this consumes is `decisions/2026/09/08/project-task-state-at-the-replay-cursor.md`
(`task-history.ts`, `traffic-timeline.ts`). This record covers only the surface choices: where the
projection is read, how an unknown past is drawn, and what the transport does on a step that is not
a message.

## Context

Agent traffic replay indexed `TrafficRecord[]` and drew every card in its current state. Two
consequences: an hour in which the board moved but nobody wrote anything had zero replay steps, and
a task that completed after the replayed message was already green. Wiring the projection means
deciding where it is evaluated, because the node graph's camera work (Seq 1808 / 1820) depends on a
stable layout.

## Investigation

Filtering the `nodes` prop by presence was tried first and rejected on inspection of the layout
path: `scene` in `TrafficNodes.tsx` is derived from the node set, so removing a node reflows the
whole stage on every playback tick — the cards under the cursor move while the camera is gliding to
them. Reading the cascade also turned up a real bug in the reduced-motion block: both card
transitions are declared on selectors carrying a `:not()`, and a media query adds no specificity, so
a bare `.traffic-node-card` override loses and the fade survives reduced motion.

## Decision

Four choices, all in `TrafficNodes.tsx` / `traffic-nodes.css` unless named otherwise.

1. **Project at `Card` render time, never by filtering `nodes`.** `projections` is a `useMemo` keyed
   on `nodes` and `cursor.at` only; the node set handed to the layout is untouched. A card that did
   not exist yet renders at its final position with `opacity: 0`, `pointer-events: none`,
   `aria-hidden` and `tabIndex={-1}`, and appears in place. Every status the card shows comes from
   the projection — `node.task.status` is not read there at all, which is the original bug.
2. **A finished card carries a stamp, not a colour.** `.traffic-node-stamp` is a filled pill with
   its own icon (`check` / `cross`) and the status word, plus a full-bleed 4px status rule at the top
   of the card, because colour alone is not a feedback channel (`better-ui`). Keeping it in this
   slice was the user's call, relayed by the coordinator; it is ~70 lines of CSS and three new icon
   paths.
3. **The `prefers-reduced-motion` block names both card selectors explicitly** —
   `.traffic-node-card.is-unborn` and `.traffic-node-card:not(.is-unborn)` — and resets the
   `transform`. See Investigation: without naming them the fade survives reduced motion.
4. **The rebuild caption is claimed only when a cursor actually stands in the past**
   (`experiment === "2" && playback.cursor.at !== null`, `AgentTrafficScreen.tsx`). Experiment 1 has
   no cursor and Experiment 2 on Live is showing the board as it is; claiming a rebuild there is the
   same falsehood in the other direction.

Two smaller consequences worth naming. The lit wire and the subject bubble are **message-only**: on
a task step the wire that was lit stays lit and no new one lights up (`currentRecord` /
`messageAt`). And the movement log records creation, status and custom-column moves and nothing
else, so hibernation, project and variant on a replayed card are the current ones — said once in the
stage caption rather than as a per-card badge the log cannot justify.

## Risks

- Coverage is thin. Movements began on this machine on 2026-09-06 and only 22 of 1924 tasks had any,
  so on real data most replayed cards read "Status not recorded". That is the honest answer, but it
  makes the feature look empty until the log fills.
- The projection runs per node per cursor move. It is a linear scan of at most
  `MAX_TASK_MOVEMENTS_KEPT` (50) entries per task, memoised per cursor instant, and the stage is
  bounded by the window — but a very large window with many recorded tasks has not been profiled.
- An unborn card stays in the DOM. It is hidden from the accessibility tree and untabbable, but it
  is still a node the browser lays out; a window with many not-yet-created tasks pays for all of
  them.

## Alternatives considered

- **Filter the `nodes` prop by presence** — rejected, see Investigation: it reflows the stage on
  every tick and undoes the camera work.
- **Show the current status with a disclaimer beside it** — the original shape, ruled out in the
  data-layer record: a green "Completed" card reads as history whatever the small print says.
- **Colour alone for completed/cancelled** (the pre-existing bold-text treatment) — rejected against
  `better-ui`: at overview zoom the card is a colour and a shape, so the verdict needs a word.
- **Synthesise a `created` movement from `Task.createdAt`** for tasks with no log — rejected in the
  data layer; it invents an instant. The surface consequence is the neutral "History not recorded"
  line instead.
