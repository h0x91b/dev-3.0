# Task header: the status bar as individual built-in items, and no more legacy clusters

## Context

Step 3.5 of the GUI-on-Cordis migration splits the last legacy cluster, the Context bar (bible §5.1, panel 1): variant switcher, watch, priority, the status dropdown with its quick-complete ✓, the completion-owner chip ("I'll complete it myself"), the diff summary badge and its include-tests segment. Its state (status menu, completion menu, diff hover, include-tests) lived in `TaskHeader`, and the narrow layout orders the same controls differently from the desktop bar.

## Decision

`src/mainview/task-header/builtin-status.tsx` defines `STATUS_ITEMS` (`builtin:status.*`) and `STATUS_DIFF_ITEMS`: the include-tests toggle is its own item in a new `status.diff` group that the diff badge draws inside its border, as `git.actions` does for the Git actions. Each item owns its own state and draws its desktop form, its narrow summary-bar form or its sheet row.
- The narrow bar puts priority after status, the desktop bar puts it before. One registration order cannot do both, so on narrow the status item draws the "status band" (status + touch priority, which the bible already treats as one band) and the priority item draws only on desktop. The narrow images/artifacts readout is a narrow-only item (`narrow-outputs`) between them and the diff; the diff item on narrow draws the compact chip, the spacer and the wide-badge slot together.
- The legacy mechanism (`LEGACY_REGIONS`, `legacyClusterId`, `LegacyRegion`, `LegacyClusters`, `useLegacyCluster`, the context's `legacy` field) is deleted with no shim.
- Host budget exceptions: `TaskHeaderRegionItems` passes the §5.1 budget (`TASK_HEADER_BAR_BUDGET`, 4) to every bar, plus the host-owned `TASK_HEADER_BUDGET_EXCEPTIONS` (variant switcher, runtime Images and Artifacts). `placeSlotItems` does not count an exempt built-in against the room left for pinned extensions. Built-ins still always show, so nothing changes on screen today. The list is the host's, so no contributor can claim an exception.
- Leftovers folded in: `isTaskActive` moved into `TaskHeaderInternals` (git and runtime items read it); `useTaskSessionController` moved to `task-header/useTaskSession.tsx` (`.tsx`, it renders the dialogs), which breaks the type-only cycle between `scope.tsx` and `builtin-session.tsx`. Group wrappers render as `span` (`SlotItems` `as`), so no `div` sits inside the inline rows.

The task's pending-completion strip under the header stays host chrome. The bible's "label strip" in this bar has no code behind it any more, so there is no item for it.

## Risks

The include-tests toggle and the badge each read `useIncludeTestsInDiff`, kept in sync by its window event, and both work out the segment's visibility the same way (`useDiffSummary`). A future change to one rule must go through that hook. The 3.6 user layout has to keep the narrow status band together: personal hiding does not apply on narrow, so this holds today.

## Alternatives considered

- **Two priority items (desktop and narrow):** two ids for one control would confuse the 3.6 hide/reorder layout. Rejected.
- **CSS `order` to swap priority on narrow:** tab order would no longer match the visual order, and the pixel diff would depend on flex order. Rejected.
- **Include-tests as part of the badge item:** simpler, but then it is not an item and 3.6 could not hide it by registry id. Rejected.
