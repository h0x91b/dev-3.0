# Adaptive split placement for `dev3 pane run`

## Context

`dev3 pane run` split whatever the backend considered current: on tmux `split-window -t <session>`
hits the session's *active* pane, and the pane it just created becomes active, so every run halved
the previous run to the right at 40% — after three or four runs the newest pane was a strip a
dozen columns wide. On native the anchor was the focused pane, which is usually the agent (focus is
handed back after a split), so there each run shrank the agent itself. Both paths were steered by
focus, which the user does not consider an input.

## Investigation

- tmux `-l 50%` on a W-cell pane gives the new pane `floor(W/2)` and the old one `W − floor(W/2) − 1`
  (measured on 3.6a, isolated server): 300 → 149 | 150, 80 rows → 39 | 40. Splitting a pane touches
  only that pane's layout cell; nothing else changes size.
- The native SplitTree splits a leaf at ratio 0.5 and gives exact normalized rects. A pane's own
  `cols`/`rows` can be stale (a pane no view has attached keeps its spawn size), so cells are derived
  from the rects scaled by the main pane's size.
- Area cannot choose an orientation (both halves of either split have the same area). Raw cell
  minimum is biased toward side-by-side splits because columns outnumber rows ~3:1. Physical aspect
  (cell ≈ 1:2) gives square panes, which wastes width terminal output wants.

## Decision

`planPaneSplit` (`src/shared/pane-split-plan.ts`, pure) decides; `decidePaneRunSplit`
(`src/bun/pane-run-placement.ts`) only reads the layout.

1. **Main pane by identity**: the caller's pane (`TMUX_PANE` / `DEV3_PANE_ID`), else the task's
   registered agent pane (tmux `sessionState`, native `pane-1`), else the oldest `@dev3_agent` pane,
   else the oldest pane. Never focus.
2. **Eligible space**: dev3's own output panes only — pane runs, dev servers, git panes, setup re-runs
   — in the main pane's tmux window. Column agents, other agents and user panes are never split.
3. **First pane**: no eligible pane yet → halve the main pane, right if both halves fit, else below.
4. **Later panes**: every eligible pane × allowed orientation, 50/50. Feasible only if both halves are
   ≥ 40×8. Score = the worse half's `min(cols×24, rows×80)` — how many 80×24 terminals its tightest
   dimension holds. Ties: bigger pane, then right before below, then older pane.
5. **No room**: refuse with `DEV3_PANE_NO_ROOM` / exit 29 and open nothing. The main pane is never the
   fallback. `--below` limits orientations to vertical; there is no forced "right" (an old CLI's
   `"right"` is read as auto).
6. A layout that cannot be read keeps the legacy split (logged) rather than failing the run.

## Risks

- The scoring encodes a taste (80×24 reference, 40×8 floor). Changing them reshapes every layout.
- Native cell estimates assume the main pane's size is current; a task never opened in a view reports
  spawn size, which skews the orientation choice (geometry ratios stay exact).
- Panes are not rebalanced after a close; the next split reads whatever the user left.

## Alternatives considered

- **Global tiled layout** (`select-layout tiled`, SplitTree presets) — rejected: rearranges the agent.
- **Always split the largest pane along its longer side** (BSP/dwindle) — simpler, but "longer side"
  in cells is wrong (cols always win) and it ignores the minimum of the smaller half.
- **Fallback to a new tmux window** — tmux-only and invisible to the user watching; **degrading below
  the minimum** — recreates the strip. Both left for a product decision if refusal proves too strict.
