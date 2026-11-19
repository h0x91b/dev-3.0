# Relaunch an agent that never started fresh, and refuse to heal an unreadable history

## Context
A Claude launch wrapper can exit before Claude creates a conversation. The stored pane id then names nothing, and Resume ran `claude --resume <id>` into "No conversation found" after the original error was gone. Separately, `sessionIdsNewestFirst` swallowed a `readdirSync` error, so a store that existed but could not be read looked empty and `resolveResumableSessionIds` silently moved panes onto the agent's own latest conversation or a new one.

## Decision
- The launch wrapper's `agent.exited` report already carries the verdict "early" (Claude with start receipts that never got SessionStart). `recordLaunchFailure` (`src/bun/agent-launch-failure.ts`) stores it as `Task.launchFailure` with the pane's last screen, written only while that launch is still the task's latest.
- `mainAgentNeverStarted` (`src/shared/agent-launch-failure.ts`) is the one rule, shared by backend and UI: `neverStarted` and the main pane has no id or still holds the failed launch's id.
- `performTaskResume` turns pane 0 into a `fresh-session` target and launches it with the original task prompt (`freshWithTaskPrompt`). Everything else (account checks, extra panes, account override, result report) is the normal resume path.
- A store dir that exists but cannot be listed marks the target `unreadable` and passes the stored id through; the resume then throws `ResumeUnavailableError("history-unreadable")` and touches no state. Start Fresh remains the explicit alternative, and the recovery screen offers it again after a refused Start again. The unreadable check covers the worktree store, the known origin store and every sibling store that could hold the id, and tells absent from unreadable per lookup.
- A never-started relaunch writes its new id into pane 0 before the terminal exists; if the launch throws, `launchTaskPty` restores the prior pane 0 (compare-and-write on the attempt id) so the verdict still matches the saved id.

## Risks
`launchFailure` lives in memory-derived receipts plus the task file: after an app restart a failure that was not yet recorded is not known, and Resume behaves as before. A temporarily unreadable store does not make the keep-alive watchdog give up at once: `history-unreadable` is retried with the normal backoff up to `KEEP_ALIVE_MAX_ATTEMPTS`, and the final give-up text says the history could not be read.

## Alternatives considered
Checking the transcript store for the stored id: it cannot tell "never created" from "store missing or unreadable", which is exactly the case that must keep the binding, and `resolveResumableSessionIds` deliberately passes ids through when the store is absent. Clearing `launchFailure` on any SessionStart: an early exit has none for its own id, and other sessions (extra pane, `/clear`) say nothing about the main one.
