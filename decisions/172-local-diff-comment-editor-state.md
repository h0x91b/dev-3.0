# 172 — Keep inline diff comment drafts inside the slot

## Context

Inline diff comments render through `@git-diff-view/react` extended-line slots. The editor previously lifted its controlled draft into `TaskDiffViewer`, above that slot boundary.

## Investigation

The library publishes a changed `renderExtendLine` callback through an effect-backed external store. Every keystroke therefore caused a delayed controlled-value write after the browser inserted the first character, which collapsed the selection to the end.

## Decision

`InlineCommentThreadView` owns the active draft while `TaskDiffViewer` retains only the globally active comment ID. The diff-view mock mirrors the library's effect-delayed slot update so the caret regression test exercises this timing boundary.

## Risks

Each mounted thread can retain an inactive local draft until it unmounts. Entering edit mode always initializes that draft from the latest saved comment body, so stale hidden state cannot reach Save.

## Alternatives considered

Capturing and restoring the selection after every controlled update was rejected because it is fragile around IME composition and browser selection timing. Stabilizing the slot callback through shared context was rejected because it expands the state boundary and still couples text input to the library's external renderer.
