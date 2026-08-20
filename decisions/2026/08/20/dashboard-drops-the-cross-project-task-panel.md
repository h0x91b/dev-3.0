# The dashboard drops its cross-project task panel, and the rail owns space order

## Context

[Issue #1295](https://github.com/h0x91b/dev-3.0/issues/1295) shipped Spaces, and
`decisions/2026/08/17/spaces-dashboard-follows-the-proposal-mock.md` gave the dashboard a
rail, a search field and a cross-project task panel at once. That record listed the cost as
its first risk: *"The dashboard grows a rail, a search field and a task panel at once. That
is a large increase in chrome on the app's calmest screen."*

In use the risk landed, and not as vague clutter. A UX pass over the shipped screen found
the panel and the centre column rendering **the same attention tasks at the same time** —
five identical tasks visible without scrolling either list. It also found two mechanisms for
one operation (space order was editable from both the rail and the group headers), and a
project row whose one navigation — into the board — carried no mark that it was a link.

## Investigation

Measured against the code, not eyeballed:

- **Duplication.** The dashboard mount of `ActiveTasksSidebar` listed attention tasks across
  projects while `ActivityOverview`'s rows listed the same tasks grouped by project. Both
  read the same `getAllProjectTasks` pool.
- **Two reorder surfaces.** `SpacesRail` rows and `SpaceGroupedProjects` header grips both
  wrote `reorderSpaces`. The header grip was `hidden md:inline-flex`, and HTML5 drag does
  not fire on touch — so reordering spaces had **no** touch or keyboard path at all, which
  is `PRODUCT_UX_BIBLE` §11's "touch-unreachable feature".
- **Width.** The rail is `w-56` (224px) and the panel was `w-[21rem]` (336px). At a 1054px
  window the two took 560px and left the work column 420px: the chrome was wider than the
  thing it framed.
- **Per-row step buttons do not fit.** 224px minus the rail's `px-3` and the row's `px-2.5`
  leaves 180px. A grip plus two 32px arrows eats ~74px, leaving ~56px for the name after the
  counts — `Third-Party` does not render.
- **`getAllProjectTasks` already loads every task** and then filters to `ACTIVE_STATUSES`,
  so a `todo` count costs no extra I/O.

## Decision

- **The dashboard has no cross-project task panel.** The `ActiveTasksSidebar` mount in
  `Dashboard.tsx` is deleted along with the props it needed (`agents`, `bellReasons`,
  `taskPorts`). The component is untouched and still serves the project view, where the
  centre is a board rather than a task list and the panel is therefore not redundant.
- **The rail is the one surface that reorders spaces.** The header grip and its drag
  handlers are gone from `SpaceGroupedProjects`, along with the `spaceOrder` prop. The rail
  keeps pointer drag, gains a resting grip glyph so the row advertises it, and gains a
  **reorder mode** (`rail-reorder-toggle`) where rows drop their filter role and counts and
  carry ↑/↓ instead — the touch and keyboard path, mode-scoped because the width is not
  there for always-visible arrows.
- **`New space` has one entry point.** The rail owns it; `ActivityOverview`'s header button
  renders only when the rail is absent, gated on the same expression that gates the rail
  (`hasSpaces && projects.length > 0 && !railHidden`) so the two cannot disagree. That
  fallback matters: at zero spaces the rail does not exist and it is the only way in.
- **A project row states its board.** The name takes accent + underline on row hover, the
  chevron takes accent and nudges, and the dead background-summary line becomes an
  always-present `↗ Open board` footer carrying the working/AI-review counts plus
  `N in To Do` from a new `todoCount` on `getAllProjectTasks`.

## Risks

- **Cross-project task search left the dashboard.** It survives in a project's sidebar on
  global scope and in the palette, but not on the screen that used to offer it. If that
  turns out to be the panel's real value, the answer is a search entry point, not the panel
  back — the duplication is what made it wrong here.
- **`todoCount` is `todo` only.** Completed and cancelled are excluded on purpose (archive,
  not waiting work), so the footer's number is smaller than "every task in this project".
  A reader who expects a grand total will read it as wrong.
- **Reorder mode is a mode**, and modes get left on. It self-exits when the space count
  drops below two, but a user who forgets it is on sees rows that no longer filter.
- **The panel removal reverses part of a two-day-old accepted design.** If the mock is
  re-litigated, this record is the counter-evidence, not an oversight.

## Alternatives considered

- **Collapse the panel by default instead of deleting it** (the reversible option, offered
  first). Rejected by the user: the duplication is the problem, and a collapsed panel still
  ships a second copy of the same rows for anyone who expands it.
- **Flip the responsive order** so the panel hid before the rail (1280 vs 1024). Moot once
  the panel is gone; the remaining ladder question — when the rail collapses and what
  replaces it below `lg` — is deliberately still open.
- **Keep the header grip and collapse every space group during a header drag** (the
  literally-requested behaviour). Rejected: collapsing mid-drag moves the drop target under
  the cursor, and the rail already is the collapsed list the gesture wanted.
- **A sixth `Open board` icon** in the row's action cluster. Rejected: it spends a slot on
  what the name already does, and icon creep is §11's named top anti-pattern here.
