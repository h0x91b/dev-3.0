# A republished artifact moves to the end of the task's list

## Context

`appendArtifactVersion` deliberately merged a republish back into the FIRST record
sharing its key, so a row the user already knew "would not jump". That reasoning ignored
the other half of the system: every surface that opens the artifact viewer does so at
`artifacts.length - 1` (`App.tsx`, `TaskInfoPanel.tsx`). With three artifacts where only
the first is ever revised, each publish opened the viewer on artifact 3 and the user had
to page back two rows to the one that had just changed.

## Decision

`appendArtifactVersion` (`src/shared/artifact-versions.ts`) now returns the merged record
appended at the end of the list, with the other rows keeping their relative order. The
record still inherits the target's `id`, so nothing pointing at it breaks — only its
position changes. Sorting the list by publish time would have been equivalent and more
fragile; the array order already is publish order.

`TaskArtifactViewer` keys its index-reset effect on the `artifacts` array identity rather
than on its length: a republish hands over a fresh list of the *same* size, so the length
dep never fired and the viewer stayed on whichever row the user was holding.

## Risks

- **A row the user knows moves.** That is the point, and it is the only way the "open at
  the last one" convention shared by every surface can be right.
- **The viewer now jumps to the fresh publish even if the user had paged elsewhere.** Same
  behaviour as before for an appended artifact; a republish is no less deliberate.

## Alternatives considered

- **Keep the order, and pass the merged row's index in the push payload.** Rejected: the
  artifact list itself would still read newest-in-the-middle everywhere it is rendered
  (`SharedOutputsList`), and every future caller would have to remember the index dance.
- **Sort the list by `createdAt` at render time.** Rejected: it puts the ordering rule in
  N consumers instead of in the one place that folds a publish in.
