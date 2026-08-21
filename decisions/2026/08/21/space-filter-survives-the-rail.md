# The space filter survives the rail, in a bottom sheet

## Context

The dashboard's space filter lived only in the rail, and the rail only exists
while its container is ≥1024px. Narrowing the window therefore cleared the
selection: the list silently grew back to every project, with nothing on screen
saying why.

## Investigation

Clearing was the honest half of a missing feature — a filter the user cannot
change is worse than no filter, so the old code chose to drop it. The fix is the
control, not the clearing: with a narrow-width picker the selection has an owner
again at every width.

An inline chip strip was the alternative (F5.1). It costs a permanent row of
horizontal chrome on the narrowest screen and degrades badly past ~6 spaces,
which is exactly the user who has spaces at all. A sheet costs one button.

## Decision

- `SpaceFilterSheet.tsx` renders the rail's own choice — `All projects`, every
  space, then `Home` — inside the existing `BottomSheet` primitive, one tap to
  select and dismiss. Default is `All projects` (`selectedSpaceId === null`),
  never a space.
- `ActivityOverview` gains an optional `spaceFilter` prop and renders its trigger
  **beside the project search field**, not in the header next to `Add project`:
  both narrow what the list shows, and a filter is not an action (§10). The
  trigger exists only while the rail does not.
- `Dashboard` no longer clears `selectedSpaceId` when the rail goes. The only
  clearing left is a selection whose space stopped existing — otherwise the list
  would filter by an id nothing can select again.

## Risks

- The filter is now sticky across a resize, so a user who filtered on a wide
  screen and narrowed sees a short list. The trigger states the space by name,
  which is the cue the old behaviour lacked entirely.
- Sheet and rail are two renderings of one choice; they share the counts and the
  `HOME_GROUP_ID` sentinel but not their markup, so a new row type has to be
  added in both.

## Alternatives considered

- **A chip strip below the header (F5.1).** Permanent chrome, and it wraps to
  three rows for the users who have the most spaces.
- **Keep clearing, but toast it.** Explains a change the user did not ask for
  instead of not making it.
- **Leave the rail on at every width.** 224px of a 375px screen, for a filter.
