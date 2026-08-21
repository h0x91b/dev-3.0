# Every space action lives in one `…` menu, on both surfaces

## Context

A space's actions were split by surface and by direction. The dashboard group
header carried a `+` (add projects) next to a `…` (rename, delete, reorder). The
rail carried none of them — it was a filter and nothing else. Removing a project
from a space was possible only from the *project's* row (`Spaces…`), i.e. from the
opposite object to the one the user was looking at.

## Investigation

The `+` opened a dialog that filtered out the space's current members, so the
dialog could not express removal at all. Reviewed on screen, that split reads as
a missing feature rather than a placement: a user who has just grouped five
projects and wants four asks "where do I untick one", and the answer was another
screen.

The rail rows had spare structure but no width: 224px minus padding leaves 180px,
already spent on grip, name, two activity dots and a count. An always-visible
per-row control was not affordable; a hover-revealed one that also *reflows* the
row would move every number in the rail the moment the pointer landed.

## Decision

- **One menu carries everything** — `Edit projects…`, `Move up`, `Move down`,
  `Rename space…`, `Delete space` (`SpaceHeaderMenu.tsx`, `scope` prop namespaces
  its test ids so two instances can render at once).
- **Both surfaces render it**: the rail row (`SpacesRail.tsx`) and the dashboard
  group header (`SpaceGroupedProjects.tsx`). The header's `+` is deleted.
- **Membership is a two-way dialog** (`SpaceProjectsModal.tsx`, replacing
  `AddProjectsToSpaceModal.tsx`): every project listed, members pre-ticked, `Save`
  inert until the tick set differs. It writes per changed project through
  `setProjectSpaces`, re-reading that project's other spaces so they survive.
- **The rail's menu keeps its width at rest** and only its ink waits for hover,
  focus or selection. Rows without a menu (Home, All projects) render an
  invisible copy of the menu glyph, so all five count columns stay aligned —
  measured live at 177.4px for every row.
- The writes behind the menu moved to `src/mainview/utils/spaceActions.ts`, since
  two components now perform them.

## Risks

- The rail's menu is hover/focus-revealed, which the manifest treats as an
  anti-pattern when it is the *only* path. Accepted because the same menu is
  visible on the group header, and the rail is desktop-only (`≥1024px`
  container), so no touch pointer depends on it.
- The membership dialog does not sort members to the top: with a stable order a
  tick never makes rows jump, at the cost of scrolling to find members in a long
  list. Search covers the long-list case.

## Alternatives considered

- **Keep `+` and add a `−`.** Two controls for one question, and `−` has no
  sensible target until something is selected.
- **Put membership editing on a screen of its own.** A space is a grouping, not a
  place (§10) — giving it a screen invites "where is this space's board".
- **Always-visible `…` on rail rows.** Costs 20px of a 180px row permanently, and
  the name is what the row exists to show.
- **Rail row menu only, header untouched.** The header is where the projects
  actually are; the user pointed at it first.
