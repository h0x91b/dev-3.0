# The Spaces dashboard follows the proposal mock, with spaces still not being places

## Context

[Issue #1295](https://github.com/h0x91b/dev-3.0/issues/1295) shipped its design as
`decisions/2026/08/14/spaces-group-projects-without-replacing-boards.md`: spaces are a global
tag on projects, every project keeps its board, and the dashboard gains a collapsible header
per space. That record described the *rules* but deliberately said little about the dashboard's
shape, so the first implementation rendered only headers over the existing rows.

Held against @arditti's interactive mock (the artifact the whole design came from), that
implementation is missing the mock's structure: a spaces rail, a search field, membership chips
on rows, richer per-space counts, and the cross-project active-task list beside the overview.
The mock is the agreed target; this record defines how each of its elements works without
breaking a rule the previous record settled.

## Investigation

Verified against the code and the previous record:

- **`NewSpaceModal` was unreachable.** The component and its tests existed, but no surface
  mounted it — so the only way to create a space was the inline-create inside Project Settings,
  while the previous record requires the dialog to be "reachable from the dashboard and from
  Project Settings". A defect, not a design choice.
- **`ActivityOverview.tsx`** already renders its rows through one `renderProjectRow` function
  (lifted for `SpaceGroupedProjects`), so chips and actions attach at one place.
- **`ActiveTasksSidebar.tsx`** takes a required `project` prop; 11 sites read it. A dashboard
  mount would have no current project — the reason the prop was made optional. The dashboard
  mount was later removed (see `calm-the-spaces-dashboard`); the sidebar stays in the task
  workspace, where the centre is a board and not a task list.
- **`ProjectActionButtons.tsx`** is the resting-visible row cluster the previous record named as
  the home of a `Spaces…` action.
- **`is:attention`** survives #1347 as a search token and funnel flag; only the sidebar *scope*
  was removed.

## Decision

The mock is the dashboard's shape. Each element maps onto the existing rules:

- **The rail is a filter, not a route.** `All projects` plus one entry per space, with counts.
  Selecting one filters/jumps within the dashboard; the route stays `dashboard`. There is no
  space screen, no breadcrumb into a space, and no space board — "a space is not a place"
  survives intact.
- **`Home` is computed by the UI, never stored.** It holds exactly the projects with zero
  memberships, cannot be renamed or deleted, is absent from every membership multi-select, and
  its rows carry no chip. `spaces.json` still is not created until the user makes a real space,
  and with zero spaces the dashboard renders its legacy flat list with no rail and no headers.
- **A project in several spaces renders under each of them**, and therefore never under `Home`
  (`Home` is the zero-membership group by definition). Chips on the row name every space it
  belongs to.
- **`+ New space` lives in the rail** — the dashboard entry point the previous record required.
- **The dashboard gains one search field** over projects, matching space names through the same
  haystack the ⌘K palette uses. One matcher, one search language.
- **A space header carries** its name, its project count, split
  "N need you · N working" counts (words, no colour dot), and one `…` menu. The drag grip and the
  add-only `+` were removed after review: space order is dragged in the rail (plus `Move up` /
  `Move down` in that menu), and membership is the menu's two-way `Edit projects…`. The mock's
  letter badges were dropped during review as visual noise — spaces have no badge and no colour
  vocabulary.
- **The row's `Spaces…` action** is the mock's `S` button, in the existing action cluster and in
  the narrow bottom sheet. No kebab is added to a *project* row (PRODUCT_UX_BIBLE §10); the `…`
  that spaces carry on their rail row and group header is the space object's own chrome, which
  §10 requires to sit against the space name.
- **The dashboard carries no cross-space task list.** The mock's panel shipped as the existing
  `ActiveTasksSidebar` mounted with `project` absent, and was removed on 2026-08-20: the project
  rows beneath it already list every task waiting on the user, so the panel rendered the same
  rows twice. Cross-project task search lives in that sidebar's global scope, inside a project.
- **The mock's `All / Needs you` toggle sets the `is:attention` funnel token.** No scope is
  resurrected; the toggle is a preset over the search field that already exists.
- **Drag still only ever reorders** (spaces by dragging a rail row, projects within a space,
  global order in `Home`). Membership changes go through the multi-select, the row's `Spaces…`
  action, or `Edit projects…` in the space menu.

## Risks

- **The dashboard grew a rail, a search field and a task panel at once.** That was a large
  increase in chrome on the app's calmest screen. The risk landed: review removed the task panel
  and the header `+`, and gated the rail on its container's width
  (`calm-the-spaces-dashboard`, `rail-gated-on-container-width`).
- **A project in several spaces still duplicates its triage rows.** Unchanged from the previous
  record, and still the first thing to watch in real use.
- **`Home` reads like a space but is not one.** The mitigation is behavioural: no chip, no
  rename, no delete, absent from multi-selects.
- **The sidebar's `project` prop becomes optional**, so every reader needs a null guard; a missed
  one is a dashboard crash rather than a wrong render.

## Alternatives considered

- **Keep headers-only** (the first implementation). Rejected: it satisfies the rules but not the
  design, and the mock is what the feature was accepted from.
- **A stored `Home` space**, as the mock literally shows. Rejected again, for the reason the
  previous record gives: it writes to every existing user's state on upgrade and then needs
  permanent exceptions. Computing it needs none.
- **One row per project with chips instead of repeating it under each space** (what the mock
  draws). Rejected: with the rail acting as a filter, a project that belongs to two spaces must
  appear when either is selected, and a single row forces an arbitrary "primary" space that the
  many-to-many model does not have.
- **A second, dashboard-specific active-task panel.** Rejected: same component, one behaviour,
  one set of bugs.
