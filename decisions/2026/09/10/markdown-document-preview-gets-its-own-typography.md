# Markdown document preview gets its own typography, not the comment scope's

## Context

Rendered markdown reaches the user through three surfaces, all styled by one CSS block in
`src/mainview/components/TaskDiffViewer.css`: PR comment bodies (`.dev3-pr-md`), the whole-file
preview in the diff viewer, and the `FilePreviewModal` a Cmd/Ctrl+Click on a terminal path opens.
The comment scope was written for short GitHub replies — `0.375rem` block margins, every heading
flattened to `0.9375rem`, a bordered chip on every inline `code`. A 200-line design document
rendered through those rules reads as one grey wall: nothing separates a heading from the
paragraph under it, and a path-heavy document turns into a field of boxes.

## Decision

`.dev3-md-doc` — the class `MarkdownContent` adds only when `document` is set — now carries a
full document type scale instead of two heading overrides: larger body size and looser leading,
per-level heading rhythm, borderless tinted code chips, an accent-tinted table header with zebra
rows, an accent blockquote wash, coloured list markers and a gradient `hr`. The comment scope is
untouched, so PR threads keep their compact look.

Colour follows one rule from `better-colors`: one hue, one meaning. `--accent` stays the link
hue, so inline code chips are neutral ink on a neutral wash; the colour the user asked for comes
from structure (heading rules, table header, quote bar, markers), never from re-using the link
colour decoratively.

## Risks

The document scope now overrides `text-sm leading-relaxed` set on the parent wrapper in
`markdown.tsx`. A future refactor that moves the doc class onto that same element would make the
font-size declaration collide instead of cascade. `.dev3-md-diff` sits on the same element as
`.dev3-md-doc` in `markdown-diff.tsx`, so the rich-diff washes now paint under the new table and
quote backgrounds — both are transparent tints, and the block wash stays visible.

## Alternatives considered

A separate `.dev3-md-reader` class applied only by `FilePreviewModal` would have left the diff
preview dense; the two surfaces show the same whole documents and should not diverge. Rewriting
`.dev3-pr-md` itself was rejected because GitHub comment threads genuinely want the compact
rhythm — a two-line reply with `1.75` leading and `1.5rem` heading gaps looks broken.
