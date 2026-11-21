> Partly superseded on 2026-11-21 by `decisions/2026/11/21/task-header-status-items.md`: the narrow-bar images/artifacts readout is now the status item `builtin:status.narrow-outputs`, not part of a cluster.
> Partly superseded on 2026-11-21 by `decisions/2026/11/21/task-header-session-items.md`: the session rows (Find bugs, + Agent, Hibernate) are now one sheet section after the runtime rows, so the old row order is no longer kept.

# Task header: the runtime bar as individual built-in items

## Context

Step 3.2 of the GUI-on-Cordis migration splits the first legacy cluster of the task header (`task-header-slot-frame`) into real items: the runtime bar (Open in…, file explorer toggle, scripts, dev server, ports, images, artifacts). The cluster read collapse and fold state straight from `TaskHeader`. Its narrow-sheet rows (ports, images, artifacts) sat in the middle of the status cluster's sheet form, between the agent rows and Hibernate.

## Decision

`src/mainview/task-header/builtin-runtime.tsx` defines `RUNTIME_ITEMS` (`builtin:runtime.*`), and `installTaskHeaderBuiltins` registers them in bar order in place of the runtime legacy cluster.
- Scripts and the dev server carry `when: project.kind !== "virtual"`.
- Each item renders its bar form on desktop and nothing on the narrow summary bar. Ports, images and artifacts also render their sheet row.
- The state that crosses bars comes from the header's internal context (`task-header-git-items`), not the public scope: its `layout` gained `narrow`, and it gained `closeSheet`. Items read it there, so nothing is copied.
- The file explorer toggle left `TaskOpenIn` and became `TaskFileExplorerToggle`, so it can be its own item.

The host now owns the sheet's `touch-actions` group: the Full screen row (chrome), then the status, runtime and session sheet regions. Hibernate moved into the session cluster's sheet form, so the rows keep their order.

## Risks

More items mean more boundaries and fibers per render. Interleaved profiler runs show the warm cost equal to the single-tree baseline, and the cold first-render cost a few ms higher, paid once per app session for the new module. The narrow-bar images/artifacts readout still belongs to the status cluster until 3.3 splits it.

## Alternatives considered

- **The sheet rows as separate items in a sheet-only region:** this would add a fifth region that only the phone layout knows about. One item with two surfaces keeps a control and its row together.
- **Keeping Full screen inside a status cluster:** it is chrome, not a contribution, and the status cluster is split in 3.3.
