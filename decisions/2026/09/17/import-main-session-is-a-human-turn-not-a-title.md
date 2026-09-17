# A main session is one a human spoke in, not one Claude titled

## Context

`scanImportableConversations` refused every Claude transcript without an `ai-title`
record: `classifyClaudeTranscript` awarded `main` only when a title was found, and the
scan then dropped everything else. A report from a user's monorepo store measured 121
transcripts carrying exactly 1 `ai-title` and 0 sidechain runs — 120 real conversations
the import offered nothing for, most of them written by the Claude Code desktop app.

## Investigation

Measured on this machine's own store (829 transcripts, `~/.claude/projects`):

- 608 carried an `ai-title`, 221 did not. Running the real classifier over the store:
  704 sessions are main, of which only 606 passed the old title gate — **98 real
  conversations were hidden**.
- The desktop app is identifiable: records carry `entrypoint: "claude-desktop"`. The one
  such transcript here DOES carry an `ai-title`, so "the desktop app never writes
  `ai-title`" is not confirmed as a mechanism — but it does not matter, because the
  title is missing often enough under plain `cli` and `sdk-cli` too.
- No separate title store was found. `~/.claude/history.jsonl` holds prompt history keyed
  by project with no session id, and `~/.claude/sessions/*.json` is keyed by process id.
  Neither can attribute a title to a session, so no secondary source was used.
- `user` records also carry harness echoes of slash commands and `!` bash lines. The tags
  actually present in the store: `command-name`, `command-message`, `local-command-caveat`,
  `local-command-stdout`, `bash-input`, `bash-stdout`. Agent traffic (`dev3-ai-message`,
  `teammate-message`, `task-notification`) is a real message and stays.

## Decision

`classifyClaudeTranscript` (`src/bun/conversation-import.ts`) classes a transcript `main`
when it holds at least one human turn, and `empty` otherwise — the class formerly called
`untitled` is gone, because the title never was the question. It also returns the first
request, and `scanClaudeStore` titles a card with `ai-title` when present and
`titleFromFirstRequest` (the renamed `codexTitleFrom`, now shared by both stores) when not.
`ImportableConversation.titledFromRequest` says which happened, so the import modal explains
the fallback for either agent instead of only for Codex.

## Risks

Sessions that were invisible now appear, so a first import offers a longer list — including
`sdk-cli` sessions, which are programmatic runs that ran in the project like any other. Both
stores' exclusions are untouched: sidechain, teammate, dev3 worktrees, path containment and
session dedupe all still decide admission.

## Alternatives considered

Reading a title out of a secondary store — rejected, no such store was found and inventing a
schema for one would be fabrication. Filtering on `entrypoint` — rejected, it would make the
desktop app a special case when the missing title is not desktop-specific.
