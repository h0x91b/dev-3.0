# Sidebar scope default is derived from space membership

## Context

The Active Tasks sidebar has three scopes (project / space / global) persisted in one
global `localStorage` key, `dev3-sidebar-scope`. The key defaulted to `"project"`, so a
project that lives in a space still opened on its own tasks — the space scope had to be
found and clicked once per install, and the switcher is 20px of Nerd Font glyph.

## Decision

`readScope()` now returns `null` when nothing valid is stored, and `effectiveScope`
derives the default per project: space when the project has at least one membership,
project otherwise (`src/mainview/components/ActiveTasksSidebar.tsx`). An explicit click
still writes the key and wins forever after — the derived default only fills the unset
case, so one stored preference cannot be right for both a spaced and a standalone
project.

The three scope buttons now read `effectiveScope` for `aria-pressed` and the accent
pill; they previously read the raw stored value, which would show no scope as selected
while a derived one was active. The disabled space button gained a struck-through
glyph (`ScopeGlyph`'s `struck` prop — the button's own `line-through` cannot reach
inside an inline-flex box) so "off" reads as off next to two merely-inactive siblings,
and its tooltip now names both routes to fix it: Project Settings and the `Spaces…`
button on the project's Dashboard row.

## Risks

The key is global while the default is per project, so switching from a spaced project
to a standalone one after ever clicking a scope keeps the clicked scope — by design, but
it means the derived default is invisible to anyone who has already used the switcher.
Space membership arrives asynchronously (`useSpaces`), so an unset scope renders
`project` for one frame before flipping to `space`; that flip costs one
`getAllProjectTasks` fetch.

## Alternatives considered

A per-project scope key would make the default always apply, but it multiplies stored
state per project and loses the "I always work globally" preference. Auto-writing the
derived value on first render would freeze today's membership into the key and make a
later join to a space invisible.
