# Fold the header switcher's space groups with a separate chevron and its own memory

## Context
The header project switcher groups projects by space, Home last, and the list grows with every space. The dashboard can fold a space; the switcher could not. Its space heading is already a menu item that opens the space board (`openSpaceBoardFromSwitcher` in `GlobalHeader.tsx`), so the heading cannot also be the fold toggle the way the dashboard header is.

## Decision
A chevron button left of each heading folds the group (`renderSwitcherGroupChevron`); the heading keeps opening the board, and Home gets the same chevron. Folded ids, space ids plus `HOME_GROUP_ID`, live in their own localStorage key `dev3-switcher-collapsed-groups` (`src/mainview/utils/switcherCollapse.ts`), default expanded. Three rules sit in `switcherFilteredGroups`: a group that holds the current project never folds, an active search ignores every fold, and a folded group's rows leave `switcherRows`, so the arrow keys and Enter skip them. While a group cannot fold, its chevron stays in place with `aria-disabled` and a tooltip that names the reason.

## Risks
A user who folds a space and later works inside it sees it open there and folded again from elsewhere; the stored fold is never cleared by this. The pinned-open rule covers Home too when the current project sits there, which the hoisting rule (`groupProjectsForSwitcher`) does not do.

## Alternatives considered
Sharing the dashboard key `dev3-collapsed-spaces`: folding a space on the dashboard would then hide rows in the menu, and the reverse, for two surfaces with different jobs. Making the heading the toggle: removes the only one-click way into a space board from the menu. Relying on search alone: it needs typing every time and does not shorten the list a user scans when opening the menu.
