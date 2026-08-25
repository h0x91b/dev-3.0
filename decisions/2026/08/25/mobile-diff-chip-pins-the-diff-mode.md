# The mobile diff chip pins the diff viewer's mode

## Context

The narrow task summary bar sheds its wide diff badge below a 400px container. On a 390px
phone that meant the badge rendered and was hidden outright, leaving the kebab sheet as the
only path to the diff — and the sheet's own Show diff row only exists for tasks without a
live worktree. So the common case (a phone, an active task) had no diff affordance at all.

## Investigation

Measured in headless Chromium at 390×844: `task-summary-bar` is exactly 390px wide, the
`diff-summary-badge` is present in the DOM and hidden by its container query.

Two other findings shaped the fix:

- `branchStatus.diffFiles` comes from `git diff <compare>...HEAD` (`getBranchDiffStats`) —
  committed work only. A branch whose changes are all still in the working tree reports zero
  files, so the wide badge never appears for it, on any width.
- `TaskDiffViewer.applyPreferredDiffMode` overwrites the requested mode with the user's
  remembered one (default `uncommitted`). A caller that knows which side carries the changes
  was therefore ignored, and the first tap landed on "No changes to show".

## Decision

`TaskInfoPanel` renders `summary-bar-diff-compact`: a 44px square (icon only, no digits) on the
narrow bar, right of the artifact readout. It shows when the branch has commits **or** a dirty
tree. With commits it hides at ≥400px, where the wide badge takes over; when the diff is
uncommitted-only it stays at every width, and its `+/−` totals appear only at ≥440px.

The digits are gated because the diff is the bar's lowest-priority item and the dirty totals
are unbounded. Measured on a real 390px bar already carrying a variant switcher, status,
priority, images and artifacts: injecting `+4000 −2000` grew the chip 29px → 69px and shrank
the status control 96px → 56px. Nothing overflowed — the status label paid for it, which is the
wrong trade for the least important chip on the row. At a 440px container the same injection
left the status width untouched, so that is the threshold.

`TaskInlineDiffRequest` gains `pinMode`, honoured by `applyPreferredDiffMode` alongside
`focusFile` / `focusFirstUnresolvedThread`. Only this chip sets it, via
`openDiffWhereTheChangesAre`.

## Risks

The 400px and 440px thresholds are container queries on a fixed number, so a bar carrying more
than today's five controls could still cross them too early. The failure mode is bounded: the
status label truncates, which is the row's documented degradation.

`pinMode` bypasses a user preference. Scoped to one caller that has evidence about which mode
is non-empty; a mode switch inside the viewer still writes the preference as before.

## Alternatives considered

- Drop the wide badge from the narrow bar entirely and always render the compact chip. One
  control instead of two, but it takes the `+/−` readout away from every 400–768px window.
- Widen the container threshold. Does not help: the wide chip is ~100px and simply does not
  fit next to a variant switcher, status, priority and two output readouts at 390px.
- Leave the mode preference alone and accept the empty first tap. Makes the new button read as
  broken on exactly the tasks most likely to be reviewed from a phone.
