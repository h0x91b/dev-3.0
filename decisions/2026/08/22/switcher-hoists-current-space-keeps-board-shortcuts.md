# Header switcher hoists the current space, but ⌘N stays on board order

## Context

The header project breadcrumb's dropdown listed every project in one flat board-ordered
list. With spaces shipped, the projects a user actually switches between (the current
project's neighbours) could sit anywhere in that list, below the scroll fold.

## Decision

`groupProjectsForSwitcher` (`src/mainview/utils/spaceGroups.ts`) wraps
`groupProjectsForDashboard` and moves every space that contains the current project to the
front, keeping their relative order. The computed `Home` group is never hoisted — "no space"
is not a space, even when the current project sits there. Zero spaces still returns `null`,
so `GlobalHeader` keeps its flat list byte-identical.

The ⌘0-9 badges are computed from board order into `switcherShortcutById` before grouping, so
a row's badge keeps matching the shortcut that actually fires. This mirrors what the ⌘K
palette already does with `shortcutIndexById` when recency reorders its rows.

Same file, `GlobalHeader.tsx`: the breadcrumb name and its chevron now live inside one
bordered segmented shell, reusing the back/forward control's markup so the two read as one
language.

## Risks

Row positions move as the user navigates — the same project sits in a different place
depending on which board is open. Accepted: the neighbours-first list is what the switcher is
for, and the ⌘N badge is the stable handle for muscle memory. A project in several spaces
still renders once per space (dashboard behaviour, kept deliberately).

## Alternatives considered

Dashboard order untouched (predictable, but the current project's neighbours can be under the
scroll fold); recency ordering like the ⌘K palette (a second, competing ordering rule for the
same set of projects); one menu button for the whole segment (loses the one-click path back to
the kanban board).
