> Partly superseded on 2026-11-21 by `decisions/2026/11/21/task-header-runtime-items.md` (and `task-header-git-items`, `task-header-session-items`): no longer true are "one legacy cluster per region" (git, runtime and session have real items) and "the status cluster's sheet form carries the runtime rows" (they are the runtime items' sheet form; the host owns the sheet's action group).

# Task header: a four-region slot, starting with one legacy cluster per bar

## Context

Step 3.1 of the GUI-on-Cordis migration (`gui-plugin-slots-and-api-versioning`) moves the task header onto a contribution slot without changing a pixel. The old `TaskInfoPanel` computes every control from shared state in one function: the git bar reports branch status that the status bar's diff badge reads, the `tight`/`compact` folds and the collapse state reach all four bars, and the narrow sheet mixes rows from several bars.

## Decision

`src/mainview/task-header/` defines `TaskHeaderRegistry` (`taskHeader`, regions `status | session | git | runtime`) on the app root, and `BUILTIN_TASK_HEADER_PLUGIN` (required, started by `main.tsx` beside the board views) registers one item per region, `builtin:<region>.legacy-cluster`. `TaskInfoPanel` became `TaskHeader` (all seven mount sites): it still builds each bar's JSX, publishes it with the task scope through a React context (`TaskHeaderProvider`, scoped to one mounted header), and draws every bar as `<TaskHeaderRegionItems>` — a `SlotItems` with `display: contents`, so the items lay out exactly as the old children did. Chrome (⚙, restore, help, info, show-panel, fullscreen, collapse, the narrow kebab) stays the host's. Narrow reads the same registry: the summary bar renders every region's `bar` form, the actions sheet every region's `sheet` form. The legacy clusters encode today's narrow layout, where the status cluster's sheet form still carries session and runtime rows; 3.2–3.5 move each row into its own item.

Internal only: no manifest kind names `taskHeader`, so the extension guard unloads any extension that registers into it.

## Risks

The clusters are JSX built by the host, so a crash inside a control is caught by its item's boundary, but a throw in the host's own derived state is not — exactly as before. Until 3.2–3.5 land, the cross-bar state stays in `TaskHeader`; each split must move the state it needs into the scope rather than copy it.

## Alternatives considered

A `ctx.task` Cordis service provided on the app root, like `ctx.board`: rejected for now, since two headers may be mounted and the service would be public surface the internal track must not add. Moving each bar's JSX and state into its item in this PR: that is 3.2–3.5, and doing it here would make the zero-diff claim unverifiable.
