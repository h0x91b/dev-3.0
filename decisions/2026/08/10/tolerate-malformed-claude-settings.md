# Tolerate a malformed .claude/settings.local.json instead of throwing

## Context

`writeClaudeHooks` (`src/shared/agent-hooks.ts`) merges dev3 hooks into the
worktree's `.claude/settings.local.json`. That file is not ours: the user edits
it, and Claude Code rewrites it wholesale from its own in-memory snapshot when
the user answers a permission or `.mcp.json` prompt. Any slot in it can hold a
shape the merge did not expect.

## Investigation

Probing `mergeClaudeHooks` / `ensureDevPermission` with malformed input found
three failure classes. Two of them are silent: `hooks.<Event>` holding anything
but an array, a root that parses to `null`, or a non-object group inside an event
threw a `TypeError`, and the only caller — `applyAgentHooksToCommand`
(`src/bun/rpc-handlers/tmux-pty.ts:527`) — logs and continues, so the agent
launched with no hooks at all. Spreading a string or array root silently injected
numeric keys (`"0"`, `"1"`) into the user's `hooks` and `permissions`.

## Decision

Every read of a foreign slot goes through `asRecord()` in
`src/shared/agent-hooks.ts`: anything that is not a plain object is treated as
absent. Per-event values are used only when `Array.isArray`, `isDev3Entry` no
longer uses the `in` operator, `mentionsDev3Cli` requires a string, and
`readSettingsFile` strips a UTF-8 byte-order mark before parsing. Installing the
hooks always wins over preserving an unparseable fragment: a dropped malformed
fragment costs the user one broken setting, a thrown merge costs them every
status transition for the whole task.

## Risks

A genuinely corrupt slot is discarded without telling anyone — `agent-hooks.ts`
is shared with the CLI and has no logger. The user sees a setting vanish rather
than an error.

## Alternatives considered

Fail loudly and refuse to launch the agent — rejected, it turns a cosmetic file
problem into a dead task. Back the file up before rewriting — rejected for now as
extra on-disk state for a case that has never been observed on a real machine;
the file is gitignored and regenerated on every agent launch anyway.
