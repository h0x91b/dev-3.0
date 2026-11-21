# Destination bodies on an internal `destinationBodies` replace slot

## Context
Phase 6 of the GUI-on-plugins plan (`decisions/2026/11/21/gui-plugin-slots-and-api-versioning.md`): a destination's
body (Sessions, Stats, Changelog, …) becomes a replace slot so a later extension can offer another body for it.
Internal first: built-ins only, no manifest kind, no public service, no API version bump. The destination, its route
and the app header stay host-owned; only what renders under the header is the slot's.

## Decision
- `src/mainview/destination-bodies/registry.ts`: one replace-kind `SlotRegistry` for every destination; an item's
  `region` names the destination it fills. `DestinationBodyProps` maps each destination to what the host passes.
- `DestinationBody.tsx` renders a destination through `<SlotHost>`, the board-view precedent: the built-in is the
  fallback (same component type, so the hand-over keeps state), a crash shows it under the inline notice. Props
  travel by React context (`useDestinationProps`), because a slot component only receives `ctx`.
- With the built-in as the only option there is no chooser and nothing is persisted (bible §5.12, Verdict 1); the
  requested id is always the built-in's. Choice storage per form factor arrives with the first second option.
- Destinations move one PR at a time; each adds its key to `DestinationBodyProps` and its built-in to
  `BUILTIN_DESTINATION_BODIES`.

## Risks
- Built-in bodies read internals (hooks, `api`): the recorded tech debt shared with every slot.
- `DestinationBodyProps` carries App callbacks (`onOpenTask`); it must not become the public contract as is — an
  opened slot needs `ctx.*` services instead.

## Alternatives considered
- One registry per destination — the same code three to six times, and no single place to list replaceable bodies.
- Passing props through the slot item's component signature — `<SlotHost>` and `SlotComponent` render `{ ctx }`
  only; widening them for one slot would leak into every replace slot.
