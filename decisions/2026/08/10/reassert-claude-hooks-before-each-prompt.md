# Re-assert Claude hooks before every prompt delivery

## Context

dev3 installs its Claude hooks into the worktree's `.claude/settings.local.json`
once, at agent launch. The file is not ours: Claude Code rewrites it wholesale
from its own in-memory snapshot when the user answers a permission or `.mcp.json`
prompt, and an MCP server or user hook can rewrite it too. A snapshot taken
before our hooks landed puts the file back without them, and the task then stops
moving between columns for the rest of the session with nothing in the UI to say
so. A user reported exactly that shape — `permissions.allow` plus
`enabledMcpjsonServers`, no `hooks` key — on a machine we cannot inspect.

## Decision

`deliverAgentPrompt` (`src/bun/agent-prompt-delivery.ts`), the single seam every
prompt goes through, now calls `refreshClaudeHooksForTask`
(`src/bun/agent-hooks-refresh.ts`) before typing. Sending a prompt is the right
moment because the prompt itself fires `UserPromptSubmit`: the hooks must be in
place before it lands, not after. `writeClaudeHooks` returns whether it wrote
anything and skips the write when the parsed result equals what was read, so the
steady state costs one read and never churns the mtime of a file Claude holds
open. The refresh is Claude-only — Codex reads its dev3 hooks from a
`-c hooks=...` override fixed at launch, so rewriting its file mid-session would
change nothing. It swallows every error: a failure here must not swallow the
user's message.

## Risks

The check only runs when a prompt is delivered through dev3. A user typing
straight into the terminal gets no refresh, so hooks dropped mid-session stay
dropped until the next dev3-delivered prompt or agent relaunch. The refresh also
resolves the agent registry and the project on every prompt — two cached reads,
but not free.

## Alternatives considered

`fs.watch` on the settings file for every live task — catches the case this
misses, but costs a watcher per task and has to survive worktree removal; kept as
a possible follow-up. A periodic timer — rejected, it has no natural period and
does work when nothing is happening. Writing unconditionally on every prompt —
rejected, it churns the mtime of a file Claude Code is actively reading.
