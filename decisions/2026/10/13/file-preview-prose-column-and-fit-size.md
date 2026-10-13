# File preview: prose column, breakout blocks, content-hugging size

## Context
PR #1954 made the file preview fill the screen and dropped the `max-w-[70ch]` wrapper around rendered Markdown, so a short note stretched into one ~200-character line across a giant empty dialog. The fix had to keep tables and code wide without bringing back a narrow box for everything.

## Decision
- **Per-block width, not window width** (`TaskDiffViewer.css`, `.dev3-file-preview-md .dev3-md-doc`): every top-level block gets `max-width: min(100%, var(--dev3-prose-measure))` and `margin-inline: auto`. The measure is 32rem (≈ 70–75 characters) in the fit size and 56rem (≈ 110–115) once expanded, keyed on the dialog's `data-size`; with 32rem in both, Expand bought nothing. Streamdown's `table-wrapper`, `code-block` and `mermaid-block` get `width: fit-content` with a `min-width` of the measure, so a narrow one shares the prose's left edge and a wide one grows to 100% and scrolls inside its own `overflow-x-auto` wrapper. Fences use `white-space: pre` and are their own scroll container: when Streamdown's wrapper scrolled instead, the `pre` frame slid off with the text. Wrap lines stays a Source-mode control.
- **Block layout, not a named-line grid.** A grid breakout is the textbook pattern but grid items never collapse margins, which would double every gap between paragraphs and headings.
- **Images centre at natural size** (Streamdown emits image-only paragraphs as bare `<img>` children). Left-aligning a small image with the prose would need its own width in CSS, which only a wrapper element could supply.
- **Size** (`FilePreviewModal.tsx`): `fit` by default (≤60rem wide, height hugs content up to the screen), `expanded` fills the screen; an Expand / Restore size header toggle persists in `localStorage` (`dev3-file-preview-expanded`). This reverses #1954's removal of the toggle, at the user's request. `useFitHeightFloor` makes the fitted height grow-only while one file is open, so Wrap lines, Raw/Rendered or the find bar never shrink the dialog under the reader. The floor is capped with `min(…, 100dvh - 4rem)` because `min-height` beats `max-height`.

## Risks
Images loading slowly off disk can still grow a short dialog once after open. The floor is per open dialog, so a window resized smaller keeps the cap but not the grown height.

## Alternatives considered
Always full screen (#1954 as-is): unreadable short notes. Content-hugging height without a toggle: no way back to a full-screen view for a big table. A `ch`-based measure: `ch` resolves per element, so headings would get a wider column than paragraphs.
