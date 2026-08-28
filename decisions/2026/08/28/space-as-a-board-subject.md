# A space is a subject of the board, not a destination

## Context

Spaces shipped as a way to group projects on the dashboard (see
`decisions/2026/08/14/spaces-group-projects-without-replacing-boards.md`), but the
kanban stayed one project at a time. A user running several repos for one client
could see that those repos had work waiting and still had to visit three boards to
move three cards. The mental model they hold — "this client's work" — had no screen.

Issue #257 previously rejected a merged board as an uncanny valley: it looked like a
board and you could not work in it. The navigation budget in
`docs/ux/PRODUCT_UX_BIBLE.md` §4 is also fully spent at 8 destinations, so a "space
screen" was not available either.

## Decision

The existing board screen gained an optional **space** as its subject: `Route`'s
`{ screen: "project" }` carries `spaceId` (`src/mainview/state.ts`, `routeSpaceId`),
`ProjectView` fetches one task snapshot per member project, and `KanbanBoard` takes
`space` + `memberProjects`. Reached from a zoom-out button beside the project
switcher in `GlobalHeader`, from ⇧⌘U (`zoom-out-to-space` in `keymap.ts`), from the
⌘K palette, and from `dev3://space/<id>`.

Four things make it a board you work in rather than a report, and each is the same
code the project board runs: drag (`moveTaskToStatus` already takes the task's own
project), creation (`CreateTaskModal`'s project field, narrowed to members), filters
(the label bar and the token DSL, unchanged), and opening a card.

`getBoardColumns` (`src/shared/types.ts`) became a pure function of a SET of
projects; a set of one returns exactly what it returned before, which is what
`src/mainview/__tests__/getBoardColumns.test.ts` pins. Across several projects the
lanes are the union, custom columns merge by normalized name, and a merged lane
carries every contributing project's own column id — that mapping is what makes a
drop unambiguous (`laneColumnIdForProject`) and a refusal visible before the drop
(`laneAcceptsProject`, rendered as a dimmed lane).

## Risks

- **Per-project column renames are dropped.** `customStatusLabels` is per project and
  two projects that renamed the same status cannot be reconciled; a space board shows
  dev3's canonical names. A user who renamed "Your Review" in one project sees the
  canonical name there. Deliberate: inventing a merged label would misrepresent both.
- **Lane order across projects is a merge, not a user setting.** The first member lays
  down the spine. Reordering, renaming and adding columns stay on a project's own
  board, because a merged lane has no single order or name to write.
- **N task fetches on open.** One `getTasks` per member project, plus one
  `getProjectPRs` each. Spaces are small by construction, but a very large space pays
  for it on every board entry.
- **A brief single-project flash.** Spaces arrive over RPC, so the board fetches the
  anchor project first and widens once membership lands.

## Alternatives considered

- **A separate `getSpaceBoardColumns`.** Rejected: the repo forbids parallel paths,
  and a second column function would let the two drift — the single-project case is
  the degenerate input of the general one, and the old test suite is the guard.
- **A space as its own route/screen.** Rejected: the navigation budget is spent, and
  a route that stopped resolving to a project would break every existing
  `projectIdForRoute` reader.
- **An "all projects" board.** Rejected: it cannibalizes spaces — the user would live
  in it and filter, and we would be back to asking what a space is for.
- **A cross-project task panel.** Already shipped once and deleted
  (`decisions/2026/08/20/dashboard-drops-the-cross-project-task-panel.md`) for showing
  the same tasks twice. This board groups by column, and a task belongs to exactly one
  project, so it appears exactly once.
