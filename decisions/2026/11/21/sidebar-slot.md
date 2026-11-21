# Task view sidebar on an internal `sidebar` replace slot

## Context
Phase 6.6 of the GUI-on-plugins plan (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): the task
view's left sidebar (the Active Tasks list) becomes a replace slot. Internal first: built-ins only, no manifest kind,
no public service, no API version bump. The plan assumed a narrow sidebar path; there is none — `ActiveTasksSidebar`
has one mount, `ProjectView`'s wide `SplitLayout`, and narrow task views render no sidebar at all.

## Decision
- `src/mainview/sidebar/`: a replace-kind `SidebarRegistry` of its own, not `destinationBodies` — the sidebar is
  part of the project/task view, not a destination. `builtin:active-tasks` is its only, required item.
- `<Sidebar>` takes `ActiveTasksSidebarProps` and renders through `<SlotHost>` with the built-in as fallback;
  the props travel by React context (`useSidebarProps`), as for destination bodies.
- Wide-only, exactly as today: the narrow layout is untouched and no narrow sidebar is invented (that would be a
  new surface for `/ux-principal`). `ReplaceSlotItem` has no `supportsNarrow` field, so none is added here; the
  future chooser must offer a replacement only where it supports the layout it is shown in.
- One option, so no chooser and nothing persisted (bible §5.12, Verdict 1).

## Risks
- The slot's props are `ActiveTasksSidebarProps` (App internals such as `dispatch`): fine internally, not a public
  contract.
- A throwing built-in is its own fallback and re-throws to the parent boundary, as for every replace slot.

## Alternatives considered
- A `sidebar` region in `destinationBodies` — mixes a view part into the destination list and its props map.
- A generic "single replace slot with props" host shared with destination bodies — two call sites do not pay for
  the abstraction yet.
