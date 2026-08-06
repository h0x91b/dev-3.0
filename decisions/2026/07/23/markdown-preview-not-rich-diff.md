# 161 — Markdown preview toggle instead of GitHub-style rich diff

## Context

Issue #1063 asked for a way to view Markdown files in the Diff view as rendered
output, suggesting either a source/preview toggle or a GitHub-style "rich diff"
(rendered output with inline added/removed highlights). An explicit scope
decision was required.

## Decision

Ship a per-file source-diff ↔ rendered-preview toggle; rich Markdown diff is
out of scope. The toggle lives in the file header of `TaskDiffFileSection`
(`src/mainview/components/TaskDiffViewer.tsx`), shows only for `.md`/`.markdown`
files, and renders the file's *new* content (old content for deletions) through
`renderMarkdownDocument` (`src/mainview/components/pr-review/markdown.tsx`) —
the same `marked` + `sanitize-html` allowlist pipeline as PR comments, but with
`breaks: false` because documents treat a single newline as a soft wrap.
Preview state is ephemeral (per mount, never persisted), and a diff-search jump
into a previewed file flips it back to source so the hit can be decorated.

## Risks

- Relative image paths in previewed files do not resolve (sanitizer allows only
  http/https/mailto), so local images render as broken — acceptable for v1.
- Inline commenting is unavailable while previewing (no diff lines to anchor
  to); existing comments are preserved and reappear in source mode.

## Alternatives considered

- **GitHub-style rich diff**: requires diffing rendered HTML trees (or
  word-level diff re-projected onto rendered output) — a new dependency and a
  large edge-case surface for marginal value over "read the rendered result".
  Can be layered on later without changing the toggle UX.
- **Global toolbar toggle ("render all Markdown")**: rejected — the view mode
  is scoped to one file, and a global control would violate the
  object-action placement rule of the UX manifest.
