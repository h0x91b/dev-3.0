# Read Cursor Agent transcripts through the Claude parser

## Context
"Add agent → Continue this task's conversation" appears only when dev3 can parse the task's newest transcript. Only Claude Code and Codex transcripts were readable, so in a Cursor Agent task the option was silently missing (h0x91b/dev-3.0#2017).

## Investigation
Cursor's on-disk format is undocumented; everything below comes from reading real transcripts.
- Files live at `~/.cursor/projects/<dir>/agent-transcripts/<sessionId>/<sessionId>.jsonl`.
- `<dir>` is the cwd with each non-alphanumeric run turned into `-`. A long cwd is truncated and given a hash suffix (`Users-x-Docume-28b6597`), so `<dir>` cannot be derived from the path. `<dir>/.workspace-trusted` holds `{workspacePath}`, the real cwd.
- Records are `{role, message: {content: [...]}}` Anthropic blocks (text, tool_use), with no `type`, `uuid`, `sessionId`, or tool_result. A `{type: "turn_ended"}` marker closes each turn.
- Each prompt is wrapped in `<timestamp>…</timestamp><user_query>…</user_query>`.

## Decision
- `cursorLocator` (`src/bun/conversation-search.ts`) maps dirs to worktrees through `.workspace-trusted`. A derived dir name is used only when that dir has no trust file of its own, because the encoding is lossy.
- `parseMessageTranscript` (`conversation-parsers/claude.ts`) is the Claude parser with a `source` argument. When a record has no `type`, it falls back to `record.role`.
- `parseCursorTranscript` (`cursor.ts`) takes the session id from the file name and strips the prompt wrapper.
- `CURSOR_OPS` (`conversation-tools.ts`) adds Cursor's own tool names (`Shell`, `AwaitShell`, `StrReplace`, `AskQuestion`) on top of Claude's table.

## Risks
Cursor can change any part of this without notice. The likely breakages are dropping `.workspace-trusted`, changing the hash scheme, or changing the record shape. Any of them would bring back the silent "no handoff option" symptom, not a crash. Re-check the format against a fresh transcript when Cursor ships a new CLI.

## Alternatives considered
- Reproducing Cursor's truncate-and-hash scheme: it is unknown, and the trust file already names the path.
- A separate full parser: it would duplicate about 300 lines of Claude parsing for a format that differs only in its discriminator key.
