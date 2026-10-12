# Claude panes claim their own conversation on resume

## Context

A tmux task with several Claude panes came back after a restart with most panes on ONE conversation (h0x91b/dev-3.0#1950). `verify-resume-session-id-against-transcripts.md` heals a stale pane id to the worktree's newest transcript, but `resumeTask` ran it per pane, so every stale pane got the same newest file. The pointers go stale because dev3 records only the launch `--session-id`: `/clear` starts a new id, an in-session `/resume` switches to another, and a never-prompted pane has no transcript at all.

## Investigation

Measured on Claude Code 2.1.296. `--resume X` keeps appending to `X.jsonl`. After `/clear`, the next `UserPromptSubmit` reports the new `session_id`, whose file has just appeared. After `/resume Y` it reports `Y`. A hook process sees `CLAUDE_CODE_ENTRYPOINT=cli` under the interactive CLI and `sdk-cli` under a nested `claude -p` run, and both inherit the pane's `$TMUX_PANE`.

## Decision

- **Capture.** `dev3 hook claude-prompt` (`src/cli/commands/claude-prompt.ts`) sends `$TMUX_PANE` unless the entrypoint is something other than `cli`. `task.promptSubmitted` passes it to `capturePaneSession`, which for Claude uses `placeRecordedPaneSession`: only the entry recorded for that exact pane moves. A pane dev3 never recorded, such as an agent-team teammate or a Claude started by hand, is ignored rather than adopted.
- **Resume.** `resolveResumableSessionIds` (`src/bun/agent-transcripts.ts`) resolves every pane from one snapshot. Valid ids are claimed first, then stale ones take the newest unclaimed transcript, and a pane with nothing left gets `startFresh`. `resumeTask` launches that extra pane with a new `--session-id` instead of `--continue`, and saves the id each extra pane resumed.

## Risks

- A stale pane takes the newest *unclaimed* transcript, which may be an older conversation of the worktree rather than its own. That still beats sharing another pane's live conversation.
- The main pane ignores `startFresh` and keeps `--continue`. It always receives the brief as its first prompt, so it nearly always has a transcript of its own.
- Capture starts at the pane's next prompt. A `/clear` with nothing typed afterwards keeps the pre-clear id, which still resumes.

## Alternatives considered

- **Reading `transcript_path` for the id.** It is never read by design (see `src/cli/__tests__/claude-prompt-hook.test.ts`), and `session_id` measured identical.
- **Capturing on `SessionStart`.** After `/clear` it reports an id whose transcript does not exist yet, so a restart before the next prompt would heal it away anyway.
- **Adopting unknown panes the way Codex does.** Claude's teammate panes report from panes dev3 never launched, and adopting one would hand a recorded pane someone else's conversation.
