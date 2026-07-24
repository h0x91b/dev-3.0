# 164 — Inspector bars adapt to the panel's width, not the viewport's

## Context

On a ~1100px window the task inspector's two toolbars overlapped and clipped: the label
chips painted over the tmux controls, and the pinned chrome (fullscreen, collapse) plus
the whole Runtime cluster (Dev Server, Ports, Artifacts) sat outside the panel's
`overflow-hidden` box — invisible and unclickable. Both rows are single non-wrapping flex
lines of ~16 `flex-shrink-0` items, and their only adaptation gates were viewport-based
(`useCompact` 1600, `useNarrowViewport` 768).

## Investigation

Measured in a browser at a 1100px viewport (panel 1068px): row 1 `scrollWidth` 1126 with
the chrome buttons laid out at x=1092–1142; row 2 `scrollWidth` 1199. The label strip
resolved to `width: 0` with `scrollWidth: 211` — it was the only shrinkable box in the
row, so it collapsed while its `flex-shrink-0` chips spilled over the next bar. That is
the visible "overlap". Viewport width was never the constraint: in split view the board
takes most of the window, so the panel is 400-600px narrower than the viewport that
`useCompact` measures.

## Decision

The inspector bars now gate on their **own container width** (`useContainerWidth`,
a ResizeObserver hook — `src/mainview/hooks/useContainerWidth.ts`) via two tiers in
`TaskInfoPanel.tsx`: `tight` (< 1280px) folds the label strip into its `+k` count chip,
clamps the branch name, and drops the text labels of the tmux layout button and of the
Runtime controls (`compact` prop on `TaskTmuxControls`, `TaskOpenIn`, `TaskDevServer`,
`TaskExposedPorts`, `TaskSharedImages`, `TaskArtifacts`); `veryTight` (< 900px) also drops
the label strip and the include-tests toggle. Independently, every bar is now boxed
(`min-w-0 overflow-hidden`) so its contents can never paint over a neighbouring bar or
over the pinned chrome — folding happens first, clipping is only the backstop. The
completion-ownership chip always uses the short label (`task.manualCompletionShort`),
since the full sentence cost ~180px of bar (more in ru/es) for a state the accent icon
already carries.

## Risks

- The thresholds are content-blind: an unusually long status label or branch name can
  still clip inside its own bar (measured: ~25-60px in the 768-900px band). Nothing
  overlaps and every control stays clickable, which is the invariant that matters.
- ResizeObserver is absent in happy-dom, so `tight` is `false` in tests unless stubbed
  (see `TaskInfoPanel.test.tsx` → "tight panel container").

## Alternatives considered

- **Wrap the rows** (`flex-wrap`): the collapsed panel has a fixed 4.25rem height and the
  expanded one a `MAX_RATIO` budget, so a wrapped second line is clipped, not shown.
- **Lower `COMPACT_MAX_WIDTH`**: still the wrong axis — it measures the window, and would
  strip labels on a wide window whose panel is roomy.
- **Overflow-kebab per bar**: correct at scale but adds a surface and two more taps for
  controls that only need their text dropped; revisit if the bars grow again.
