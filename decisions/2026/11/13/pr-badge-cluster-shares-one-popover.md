# PR badge cluster shares one popover

## Context

`TaskPrBadges` wrapped each badge (number, mergeability, review, unresolved comments) in its own `TaskPrStatusPopover`. Each popover opened 6px right of its own badge, which is exactly where the next badge sits, so it covered its siblings. Pointing at a sibling through the gap opened a second popover while the first was still in its 160 ms hover-out delay, and the two stacked.

## Decision

The cluster renders one `TaskPrStatusPopover` around all badges. Its trigger wrapper is `display: contents`, so the host's flex row still lays the badges out one by one, and `anchorRect` uses the union of the wrapper's children, so `computeBesidePosition` places the card beside the whole cluster. A module-level `hideOpenPopover` in `TaskPrStatusPopover.tsx` closes any open PR popover the moment another one opens.

## Risks

- A `display: contents` element has no box; any future caller that measures the wrapper itself gets zeros. `anchorRect` falls back to the wrapper rect only when no child has a size.
- The single-open rule is global: two PR popovers can never be visible together, which is the intent today.

## Alternatives considered

- Keep per-badge popovers and offset them: still covers the badge row on narrow hosts (Active Tasks sidebar).
- A React context popover group: more code for the same result, since all triggers already live in one component.
- Floating UI's `FloatingDelayGroup`: a new dependency for one surface.
