## Context

We needed inline code comments in the built-in diff viewer without forking `@git-diff-view/react` or replacing our per-file diff rendering in `src/mainview/components/TaskDiffViewer.tsx`.

## Investigation

The library does not expose a dedicated comment API. Its comment-style UX is built from `diffViewAddWidget`, `renderWidgetLine`, and `extendData` / `renderExtendLine`. It also exposes `generateInstanceFromLineNumberRange(start, end, side)`, but that only slices the visible diff and does not provide a native multi-line comment target.

## Decision

We integrated inline comments through the widget/extend hooks already supported by `DiffView`. New comments open in a widget composer anchored to one `side + lineNumber`, and saved comments are rendered back through extend data. Our local comment shape stores `startLine` and `endLine`, even though both are currently the same line, so future multi-line comments can reuse the same structure.

## Risks

Widget state is line-based and owned by the library, so true drag-to-select comment ranges will need custom UI on top of the diff DOM. Comments are local-only for now, so switching diff modes or reloading the viewer clears them.

## Alternatives considered

Forking the library was rejected because the existing widget API is sufficient for single-line inline comments and keeps us on the upstream package. Pretending that `generateInstanceFromLineNumberRange()` is a multi-line comment API was rejected because it only narrows the rendered diff window.
