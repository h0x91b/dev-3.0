# Claude's protocol always travels as a file, and a failed write is fatal

## Context

The dev3 protocol was injected into Claude's launch as `--append-system-prompt <body>`,
about 29 KB of ordinary English prose sitting in every agent's `argv`. `pkill -f` and
`pgrep -f` match the whole command line, so any pattern that occurs as a word in that prose
matched every running agent: one agent restarting its own browser daemon SIGTERMed every
sibling on the machine, twice in two days (h0x91b/dev-3.0#1734). The victim's pane showed only
`✗ Process exited with code 143`, which points the investigation at anything but the real cause.

The file channel already existed — written for Windows, where the body plus a task description
does not fit the 32 767-character command line
(`decisions/2026/08/28/agent-command-lines-quote-in-the-launch-dialect.md`). It was gated to the
PowerShell dialect, so no POSIX launch ever used it.

## Investigation

The gate turned out to be the whole bug: `systemPromptNeedsFile()` answered a question about
shell quoting, and the call site used it as if it answered a question about safety. Nothing else
had to change to close the exposure — ungating `systemPromptFileFor()` is the fix, and the
contributor's PR #1738 did exactly that.

Two follow-ups were needed to make it hold. First, the write was not atomic: `~/.dev3.0` is
shared by every installed version of the app, different versions carry different protocol text,
so two versions running side by side fail the "has the body changed" check in both directions and
rewrite the file continuously. The reader is another process — the agent being launched — so a
truncate-then-write could hand it half a protocol with no error anywhere. Second, a failed write
returned `null` and the launch silently fell back to the inline body, which is the exposure this
change exists to remove.

## Decision

`src/bun/agents.ts` — `systemPromptFileFor()` supplies the file for every Claude launch on every
platform. `src/bun/agent-system-prompt-file.ts` — `ensureAgentSystemPromptFile()` writes through a
temp name in the same directory and renames it into place, and **throws** when it cannot write
instead of returning `null`. `systemPromptNeedsFile()` is deleted; nothing asks that question any
more. The pure adapter in `src/shared/agent-adapters/claude.ts` keeps its inline branch for a
caller with no backend behind it; dev3 itself never reaches it.

The `AGENTS.md` ban on renames under `~/.dev3.0` is about moving user state between paths, where
another installed version would look at the old path and find nothing. This rename is a temp file
created milliseconds earlier, moved onto a regenerated cache file under a name that never changes.
Nothing reads the temp name and no state moves.

## Risks

An unwritable `~/.dev3.0/data` now blocks Claude launches instead of degrading them. That is
deliberate — the degraded mode is the bug — and such an install is broken in more visible ways
already, since every board, task and worktree record lives under the same root.
`--append-system-prompt-file` is not listed among the flags in `claude --help` (verified on
2.1.269, where it is only mentioned in prose and works); an old enough Claude Code that lacks it
would fail to launch on POSIX, where before it would merely be exposed.

## Alternatives considered

Content-addressing the file name (`claude-<sha>.md`) so two app versions cannot write the same
path. It removes the rewrite churn, but the atomic rename already guarantees a reader sees one
whole body or the other, and immutable per-body files accumulate forever. Rejected as more
machinery than the property needs. Keeping the `null` return and surfacing a toast instead of
throwing was rejected for the same reason the fallback was: a launch that quietly re-arms #1734 is
worse than one that refuses.
