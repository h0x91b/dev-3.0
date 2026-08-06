# 033 — Inline Diff WKWebView Paint Workaround

## Context

The inline diff viewer sometimes showed obviously wrong row content in the desktop app even though the underlying git patch and parsed diff data were correct. The corruption reproduced only in the Electrobun renderer (WKWebView), not in isolated diff data inspection.

## Investigation

`git diff`, merge-base content, `@git-diff-view/core` split/unified line data, and isolated React renders all produced the expected rows. The visible corruption only appeared in the app shell, which pointed to a WebKit paint/layout issue rather than bad diff data.

## Decision

In [src/mainview/components/TaskDiffViewer.css](../src/mainview/components/TaskDiffViewer.css), override `@git-diff-view` tables from `border-collapse: collapse` to `separate` with zero spacing and force the diff scroll layer onto its own compositing layer. In [src/mainview/components/TaskDiffViewer.tsx](../src/mainview/components/TaskDiffViewer.tsx), force `DiffView` to remount when the mode/theme/diff payload hash changes so stale paint/state cannot survive view transitions.

## Risks

The workaround is intentionally narrow but still changes third-party table layout behavior, so subtle spacing differences are possible. The visual bug is WKWebView-specific, so automated DOM tests do not fully cover it.

## Alternatives considered

Leaving the bug alone was not acceptable because the viewer displayed fake code. Rewriting the diff renderer or patching `@git-diff-view` directly was too expensive for a renderer-specific paint issue with a smaller CSS/remount workaround available.
