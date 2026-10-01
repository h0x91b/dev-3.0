# Recent task notes at session start

## Context
A new conversation in a long task starts blind: notes are the durable record, but an agent only saw them if it thought to run `dev3 note list`. No launch, hook or skill path injected them (verified on `4ea218250`).

## Investigation
Claude Code 2.1.286 and Codex 0.159.0 both accept `hookSpecificOutput.additionalContext` on `SessionStart` (Claude's zod schema and Codex's embedded `session-start.command.output` JSON schema, read from the installed binaries), and both send a `source` of `startup|resume|clear|compact|fork`. Codex's dev3 hook already ran on `startup|resume`; Claude had no `SessionStart` entry. Consumption by the model was not observed live (no paid launch).

## Decision
- `src/shared/recent-notes-context.ts` renders the 5 newest notes (by `createdAt`, ties by insertion order) under a 6000 UTF-16-unit cap for the whole block, 1200 per body, water-filled so short notes stay whole; every body line is quoted so a note cannot fake a heading or the footer; cuts are labelled with `dev3 note show <id>`. Over budget it drops whole older entries, never the footer.
- Claude: a new `SessionStart` entry (`startup|clear|compact`) → `dev3 hook claude-session-start`. No status move — Claude's status hooks do not use `SessionStart`, and adding one would claim an idle fresh session is working.
- Codex: the existing handler answers `additionalContext` on `source: startup` only. The matcher stays `startup|resume`: widening it to `clear` would also move the task to in-progress on an idle `/clear`.
- `dev3 note recent` prints the block and exits 0 offline, because the Claude `/dev3` skill runs it as an injection. The Codex skill can only instruct it.

## Risks
Characters are not tokens: 6000 chars of CJK or emoji can cost several times the tokens of English. Codex `/clear` and resume get no automatic block. The AI reviewer shares the worktree's Claude hooks and also receives the notes (same task, so no isolation breach).

## Alternatives considered
Extending `dev3 current` (rejected: it is called on many turns, the block would repeat); baking notes into `--append-system-prompt` / `developer_instructions` (rejected: static at launch, and Codex's travels on the Windows command line under a hard length cap); summarizing notes with a model (rejected: cost, latency, and a lossy paraphrase of the durable record).
