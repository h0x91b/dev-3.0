The module header of `src/shared/coordinator-board.ts` described a `UserPromptSubmit` hook that was built and then removed before the feature shipped, and cited a decision record that does not exist. It now describes the real delivery seam (the `coordinatorBoardEpilogue` trailer on `deliverAgentPrompt`), names the user's own pane typing as a known limitation instead of omitting it, and points at the record that actually shipped.

Suggested by @mcaldas (h0x91b/dev-3.0#1539)
