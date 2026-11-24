# A narrow control row sheds; it never stacks

Moved out of `docs/ux/UX_DECISIONS.md` on 2026-11-24 so the log stays an index; the rule itself lives in bible §12.6 and §12.3.

## Context
A task's summary bar on a phone wrapped into a second row when it ran out of width: at 340px it grew from 40px to 67px tall.

## Decision
A narrow control row is `flex-nowrap`, sheds its least important controls in a written priority order at container-query thresholds, and puts everything it shed into a sheet path. Evidence: `TaskHeader.tsx` (`task-summary-bar`, `diff-summary-badge`, `summary-bar-diff-compact`), `TaskDiffViewer.tsx` (narrow mode row), seq 1459. Refinement (seq 1676): the diff sheds its *width*, not the control — `decisions/2026/08/25/mobile-diff-chip-pins-the-diff-mode.md`.

## Risks
A shed control is one tap further away; the sheet must list every one of them or it becomes unreachable.

## Alternatives considered
- A second row: costs the phone a band of screen and moves every control the user is aiming at.
- JS-measured overflow via `ResizeObserver`: oscillates once hiding an item shrinks `scrollWidth`, and recovering the natural width needs an offscreen clone.
- A viewport breakpoint: the row is not the window — one width holds different bars with or without a variant switcher and output badges.
- Folding the readouts unconditionally: they are status, and §12.6 keeps them resting-visible whenever they fit.
