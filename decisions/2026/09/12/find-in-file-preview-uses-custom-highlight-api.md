# Find in the file preview paints with the CSS Custom Highlight API

## Context

The file preview modal (`FilePreviewModal`) had no find of its own, so ⌘F fell
through to the window-level handlers in `ActiveTasksSidebar` and `LabelFilterBar`
and focused the board search behind the modal. The preview renders two very
different bodies from the same file: a hand-built line listing, and a Markdown
document rendered by Streamdown.

## Decision

`src/mainview/utils/find-in-dom.ts` collects `Range`s by walking the text nodes of
the body container and paints them through the CSS Custom Highlight API
(`::highlight(dev3-find)` / `dev3-find-active` in `index.css`), with a Selection
fallback where the API is missing. `src/mainview/hooks/useFindInElement.ts` owns
the state and the capture-phase ⌘F/Ctrl+F listener, which calls
`stopImmediatePropagation()` so the board handlers never see the key. The bar
itself is the former `ArtifactSearchBar`, renamed `FindBar` and given a
`placeholder` prop, since it now has two homes.

## Risks

Ranges live outside React, so anything that replaces the body invalidates them —
the hook rebuilds on a `contentKey` covering the async load and the Raw/Rendered
toggle. Without the Custom Highlight API only the active match is visible (it is
selected), which is a degraded but not broken experience.

## Alternatives considered

Wrapping matches in `<mark>` elements, as `TaskDiffViewer` does for its own rows:
fine for the raw listing, but inside rendered Markdown those nodes belong to
Streamdown and a re-render would drop them. Searching the raw file text and
mapping offsets onto the rendered document was rejected as well — the rendered
text and the source do not line up (`**bold**` vs `bold`).
