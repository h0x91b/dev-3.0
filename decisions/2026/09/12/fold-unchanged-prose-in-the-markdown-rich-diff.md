# Fold unchanged prose in the markdown rich diff

## Context

The rendered markdown diff (`MarkdownRichDiff`, PR #1132) painted the whole document even when
one line changed, so a review of a long `.md` opened on prose nobody edited. The source diff never had this problem — git already
ships only hunks — but the rendered preview is the default for markdown files.

## Investigation

The change detection was already there: `buildMarkdownDiffBlocks` chunks both sides (a
top-level block, or one list item), runs an LCS over the chunks, and tags each `context`,
`added` or `removed`. What buried the change was `groupOps`, which merges consecutive
same-kind chunks into one block — so every unchanged chunk in the document collapsed into a
single `context` block and rendered whole. Folding at the block level therefore does nothing;
the decision has to be made on chunks, before grouping.

## Decision

`markVisible(ops)` (`src/mainview/components/pr-review/markdown-diff.tsx`) keeps every changed
chunk plus `CONTEXT_CHUNKS = 3` unchanged chunks on each side, and puts a hidden run shorter
than `MIN_FOLDED_LINES = 6` back — a fold row costs more than the text it would hide.
Visibility joins the `groupOps` grouping key, so a fold is always a seam between blocks, never
a cut inside one. `toRenderSegments` turns consecutive folded blocks into one row that names
how many lines it hides and, from `lastHeadingText`, which section they sit in; clicking it
unfolds in place.

Two blocks never fold: one carrying a review comment (`isCommented`), because
`revealMarkdownLine` looks the block up in the DOM and "Show in preview" would silently stop
working; and anything in a whole-new or whole-deleted file, which `isMarkdownRichDiffFile`
already routes to the plain document renderer.

## Risks

A fold seam inside a list splits it into two lists — after unfolding, the items sit slightly
further apart. Numbering survives, because each item keeps its own source text. The obvious
fix, never splitting a list run, is worse: a 200-item list with one edited item would unfold
whole, which is the bug this change exists to remove.

The rich diff already renders each block as its own markdown fragment, so a reference-link
definition or footnote in one block does not resolve in another. Folding does not introduce
that, but it can make it visible when the definition lands in a folded run. Unchanged from
before this change.

## Alternatives considered

Defaulting markdown files to the raw source diff — the original request, withdrawn by the user
because the rendered view is the readable one; the problem was its size, not its form.
A "collapse unchanged" toolbar toggle — rejected: it adds a control to a surface whose action
budget is already enumerated, and the compact view is what the reader wants by default.
A separate summary pane listing changed sections — rejected as a second surface for something
the existing preview can just stop over-rendering.
