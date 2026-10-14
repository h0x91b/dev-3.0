# Claude panes claim their own conversation on resume

## Context

A tmux task with several Claude panes came back after a restart with most panes on ONE conversation (h0x91b/dev-3.0#1950). `verify-resume-session-id-against-transcripts.md` heals a stale pane id to the worktree's newest transcript, but `resumeTask` ran it per pane, so every stale pane got the same newest file. The pointers go stale because dev3 records only the launch `--session-id`: `/clear` starts a new id, an in-session `/resume` switches to another, and a never-prompted pane has no transcript at all.

## Investigation

Measured on Claude Code 2.1.296. `--resume X` keeps appending to `X.jsonl`. After `/clear`, the next `UserPromptSubmit` reports the new `session_id`, whose file has just appeared. After `/resume Y` it reports `Y`. A hook process sees `CLAUDE_CODE_ENTRYPOINT=cli` under the interactive CLI and `sdk-cli` under a nested `claude -p` run, and both inherit the pane's `$TMUX_PANE`.

## Decision

- **Capture.** `dev3 hook claude-prompt` (`src/cli/commands/claude-prompt.ts`) sends `$TMUX_PANE` unless the entrypoint is something other than `cli`. `task.promptSubmitted` passes it to `capturePaneSession`, which for Claude uses `placeRecordedPaneSession`: only the entry recorded for that exact pane moves. A pane dev3 never recorded, such as an agent-team teammate or a Claude started by hand, is ignored rather than adopted.
- **Resume.** `resolveResumableSessionIds` (`src/bun/agent-transcripts.ts`) resolves every pane from one snapshot and claims each valid id once. Only the main pane (`adoptsOrphan`) still heals a lost id to the newest unclaimed transcript, the rescue the superseded record exists for. A pane whose own conversation is gone and finds nothing unclaimed gets `startFresh`: `resumeTask` launches it with a new `--session-id` and no brief instead of `--continue`, which would reopen a neighbour's. That covers the main pane too (`launchTaskPty`'s `freshSessionId`); a main pane that adopts a leftover reports `substituted`, even when nothing was stored. The id each pane resumed is saved. A stored id is also accepted when its transcript sits in any other directory's store (`inSiblingStore`), because an in-session `/resume` can switch to such a conversation and nothing records where it lives.
- **Reporting.** `ResumePaneMode` (`src/shared/agent-resume.ts`) gains `fresh-session` for that pane, and `dev3 agent resume` resumes it even in its strict default. `requireSessionIds` refuses `agent-latest` because the harness would pick a conversation of its own choosing — possibly another pane's; a `fresh-session` pane is handed an id dev3 minted, so there is nothing to guess and nothing to collide with.

## Risks

- An extra pane whose pointer went stale before this change (a `/clear` the hook never reported) starts fresh instead of finding its conversation. The transcript stays on disk and `/resume` inside the pane reopens it. Validation showed why adoption is worse: a never-prompted pane adopted another pane's pre-`/clear` leftover and displayed a conversation it never had.
- The main pane can still adopt an unclaimed leftover when its own transcript is gone.
- An extra pane stored as a bare command string (no `agentId`) cannot be launched on a minted id and keeps `--continue`.
- Native backend panes have no `$TMUX_PANE`, so their pointer never follows `/clear`; they resume the pre-clear conversation.
- Capture starts at the pane's next prompt. A `/clear` with nothing typed afterwards keeps the pre-clear id, which still resumes.

## Alternatives considered

- **Reading `transcript_path` for the id.** It is never read by design (see `src/cli/__tests__/claude-prompt-hook.test.ts`), and `session_id` measured identical.
- **Capturing on `SessionStart`.** After `/clear` it reports an id whose transcript does not exist yet, so a restart before the next prompt would heal it away anyway.
- **Adopting unknown panes the way Codex does.** Claude's teammate panes report from panes dev3 never launched, and adopting one would hand a recorded pane someone else's conversation.
