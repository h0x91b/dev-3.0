# 199 — Task card: five zones and a vertical lifecycle rail

## Context

`TaskCard.tsx` had grown to ~17 element classes with no zoning: identity, content,
lifecycle state, read-only signals and actions all stacked in one vertical flow at the
same visual weight, across up to three separate badge rows. Card height swung 192–266 px,
so a column never lined up. The status control — the single most important button on the
card — rendered as a plain text row wedged between badges, and the variant config string
(`Auto (Opus 5, Medium) · claude-opus-5[1m]`) burned two wrapped lines. Every new feature
had been adding a row, which does not scale: the card shows roughly half of what `Task`
and `TaskPRBadgeInfo` already know.

## Investigation

Eight layouts were prototyped as a standalone HTML artifact and reviewed with the user
(disposable, deliberately not committed — see the artifact rule in the global agent
instructions). The winner was "V8": a full-width identity header, a left lifecycle rail,
and a segmented bottom bar. The measured trade-offs that decided it:

- Full-width identity buys the header **+62 px** (182 → 244 px, +34% rel.). Not enough for
  the longest config string, which needs 138 px while the rest of the header eats 196 —
  shortening the config label is the follow-up, not more layout.
- A right-hand indicator rail (rejected) kept card height constant regardless of signal
  count, but a bare counter hides severity, and a board exists to show alarms.
- Hiding signals behind hover (rejected) broke risk scanning outright.

## Decision

Five zones with one admission rule each, recorded in
`docs/ux/ux-architecture.yaml` → `surfaces.task_card.zone_model`:

1. **Lifecycle** — the 3 px top strip plus `TaskCardRail.tsx`. The rail is the status
   control: `PipelineRing`, the attention-bell count, the short upright column name, and
   quick-complete. Two stacked buttons, not one — a `✓` nested inside the status button
   would be invalid markup and unreachable by keyboard.
2. **Identity** — one full-width header row above the rail.
3. **Content** — title (3-line clamp) and labels; the show-description affordance is an
   icon on the label row, never its own row.
4. **Signals** — the bottom bar's wrapping strip, grouped `git` / `run` / `time` with 1 px
   dividers.
5. **Actions** — a reserved strip at the bar's foot, `min-h-9`, so badges can never
   squeeze actions out.

The rail label is a short uppercase form capped at 8 upright letters (`status.rail.*` in
en/ru/es; custom columns clipped). Upright means
`writing-mode: vertical-rl; text-orientation: upright` — never rotated 90°, on explicit
user instruction. The full column label lives in the rail's accessible name and tooltip.

`mt-auto` on the bottom bar is load-bearing: the rail is usually the taller of the two
columns, and without it the bar floats and leaves a dead gap above the card's edge.

## Risks

- The rail prints an abbreviation, so tests must find the status control by its accessible
  name or `data-testid="task-card-rail"`, never by the full label text.
- Quick-complete moved into the rail and is no longer desktop-only; on narrow viewports the
  rail widens so both halves clear the 44 px touch minimum.
- `task-card-footer` is gone. Signals live under `task-card-signals`, the git group keeps
  `task-card-status-badges`, and actions keep `task-card-action-row`.
- A custom column whose name exceeds 8 characters is clipped in the rail. Two different
  label lengths in one column would otherwise stack to different heights.

## Alternatives considered

Seven other layouts, all prototyped: three-band zoning without a rail; a two-line density
mode; a hover tray; a fixed right meta-rail with positional slots; a telemetry cockpit with
a status stepper; a wide rail absorbing the alarms; and V8 without the top strip. V7 (no
strip) was rejected because the rail no longer reaches the top corner, leaving a ~31 px gap
of nothing at the top of every card during a column scan — the 3 px strip is the cheapest
fix at no layout cost.
