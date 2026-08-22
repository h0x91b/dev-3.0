# The task breadcrumb badge switches variants; the badge leaves the hover card

## Context

The header breadcrumb rendered the variant suffix (`#1636-1`) as inert text. With several
variants of one task running, jumping between them from the header was impossible — the
only paths were the ⇧⌘[ / ⇧⌘] shortcuts and the variant dots on cards and sidebar rows.

## Decision

`TaskBreadcrumbBadge.tsx` renders the badge, and when the group has ≥2 live variants it
becomes a bordered segmented control (badge half + chevron half) opening the shared
`SiblingPopover`. The gate is *live* variants, matching `getAdjacentAliveVariant`, so the
chevron always has somewhere to go. `SiblingPopover` gained `isFullPage` (mirroring
`VariantSwitcher`) so switching from the fullscreen task screen stays on that screen
instead of dropping the user onto the board.

The badge moved **out** of `TaskTitleHoverCard` in `GlobalHeader.tsx`: a control cannot
share its trigger with a hover popover — hovering the chevron would have opened the title
card underneath the variant menu. The title still owns the hover card.

## Risks

The badge no longer opens the title hover card on hover; the title does. Single-variant
tasks keep the plain badge, so the header's look is unchanged for them.

## Alternatives considered

- Border around the whole task segment (badge + title + chevron): fights truncation and
  the inline-rename affordance, and reads heavier than the project segment it mirrors.
- A bare chevron with no border: a third look in a row that already has two segmented
  controls (back/forward, project).
- A header-local dropdown instead of `SiblingPopover`: would duplicate variant-row
  rendering (status dot, agent, config, title) that already exists.
