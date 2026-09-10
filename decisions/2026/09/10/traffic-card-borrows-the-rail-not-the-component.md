# The traffic card borrows the Active Tasks rail's look, not its component

## Context

Experiment 2 of Agent traffic drew task cards that looked like nothing else in the
app: an 18px headline, three lines of overview, a status word buried in the body,
and the status colour reduced to a 2px hairline. The ask was to make them read
like the compact Active Tasks rows (`ActiveTaskRow.tsx`) they stand for, without
turning the scene into a second Kanban board.

## Investigation

`TaskCardRail.tsx` is the component that draws the rail — the coloured strip,
`PipelineRing`, and the upright stacked status word. Mounting it inside the
traffic card does not work, for two independent reasons:

1. It renders two `<button>`s (open the status menu, complete the task). The
   traffic card's root **is** a `<button>`, so that is invalid markup and the
   inner buttons are unreachable by keyboard.
2. Both buttons are new actions inside the replay scene, which is explicitly out
   of scope — the scene has click-to-select and double-click-to-focus, and gains
   nothing else.

`ActiveTaskRow` itself is worse: 20 props, and it calls `moveTaskToStatus`,
`moveTaskToCustomColumn`, `toast` and `dispatch` directly.

The upright status word is the rail's most recognizable feature, but it is a
short form — `WORKING`, `ASKING`, `PR`. The traffic card needs the *full* label,
because it also has to say `Status not recorded` and `Hibernated`, which have no
short form, and because `agent-traffic-ui.test.tsx` asserts the full replayed
label on the card as a truthfulness guard. Showing both words duplicates the
status on a 300px card; showing only the short one loses information and breaks
that guard.

## Decision

Borrow the vocabulary, not the component (`Card()` in `TrafficNodes.tsx`,
`.traffic-node-rail` in `traffic-nodes.css`):

- A non-interactive `<span className="traffic-node-rail">` at the card's left
  edge, 20px wide (`--node-rail`, the same `w-5` the Kanban card uses), washed
  `color-mix(var(--node-status) 14%)`.
- `PipelineRing` is imported and reused as-is (it is pure — `status`, `size`,
  `tooltip`), fed the **projected** status at the replay cursor. A parked card or
  one with no recorded state gets the bare strip: a ring would claim a stage
  neither has.
- **No upright status word.** The full status word stays in the card body, restyled
  to the app's uppercase tracked lifecycle type. This is the one deliberate
  difference from the sidebar.
- The rail is `aria-hidden`; the card's own `aria-label` already carries the status.
- The status colour washes the card surface (`6%`), the way an Active Tasks row
  carries `${color}0f`, and the type scale drops to the app's pitch (title 18→15px
  at weight 500, overview 13→12px, status word 11→10px uppercase).
- At the `compact` detail tier the ring is hidden and the strip stays; at `cell`
  the existing rule that hides every child already hides the rail.

## Risks

The rail eats 20px of a 300px card, so a long title clamps a word earlier. The
type-scale drop frees more vertical room than the rail costs horizontally, so
`CARD_HEIGHT` stays at the 234 that `fix-traffic-card-text-clipping` set — but
that means the card now has slack at the bottom, and a future row added to it
must re-check the height rather than assume it fits.

## Alternatives considered

- **Mount `TaskCardRail`** — rejected: nested buttons, and new actions in the scene.
- **Rail word instead of the body's status word** — rejected: loses
  `Status not recorded` / `Hibernated`, and breaks the replay-truthfulness tests.
- **Rail word in addition to it** — rejected: the same status twice on one small card.
- **Copy `RAIL_LABEL_KEY` into the traffic module** — rejected: a duplicated status
  label map drifts, and with no upright word it is not needed at all.
