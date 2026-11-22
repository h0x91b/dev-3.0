# ⌘1–9 follow the order the dashboard shows

## Context

With "Number keys follow spaces" off and at least one space, the dashboard lists projects grouped: each space's members in rail order, then Home. `digitTargets` still walked the flat stored project order, so ⌘2 opened a project the user could not find in second place anywhere on screen.

## Decision

`dashboardProjectOrder` (`src/mainview/utils/digitOrder.ts`) flattens `groupProjectsForDashboard` top to bottom, keeping a project in several spaces at its first appearance, and `digitTargets` uses it when the setting is off. With zero spaces it is the flat board order, unchanged. With the setting on, the dashboard already renders `resolveMixedOrder`, so that branch is untouched. Badges (`digitBadgeById`) and every handler (⌘N, ⇧⌘N, remote `G then N`) still read the one `digitTargets` list. Reordering spaces in the rail, members inside a space, or Home rows renumbers the digits with them.

"Dashboard order" deliberately ignores transient view state: collapsing a space, the rail filter and the search box do not renumber, so a click never moves a shortcut.

## Risks

Users who learned the old flat numbering on a board with spaces get new digits. Accepted: the old numbers matched nothing visible. The header switcher hoists the current project's space, so its badges are not top-to-bottom there; they mirror the dashboard, which is the stable handle.

## Alternatives considered

Keep flat order and badge the dashboard rows instead (the numbers would still jump around the grouped list). Count only expanded or filtered rows (digits would move on every collapse or keystroke). Make the off mode follow the mixed list (would turn spaces into targets, which is what the setting is for).
