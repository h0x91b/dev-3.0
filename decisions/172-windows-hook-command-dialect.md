# 172 — Windows hook/skill command dialect

## Context

Every generated agent command — Claude hooks in `.claude/settings.local.json`,
Codex hooks in `.codex/hooks.json` and the `-c hooks=…` session override, the
installed `SKILL.md` files, the `Bash(...)` permission rule — was built from one
hardcoded string, `~/.dev3.0/bin/dev3`, and the Claude hooks wrapped it in
`|| [ $? -eq 2 ]`. On Windows nothing expands `~`, and the agents' hook runners
give us no POSIX shell for `||`/`$?`/`2>&1`, so every one of those commands would
fail before it started.

## Investigation

The app-offline tolerance the wrapper provides is not optional: exit code 2 is
both `CLI_EXIT_CODE_APP_NOT_RUNNING` and "blocking hook error" for Claude and
Codex, so a closed app wedges the agent on every tool call (decisions 032, 089).
`|| true` was rejected there and stays rejected. `dev3 hook codex` turned out to
need nothing — it already always exits 0 — so only the Claude `task move` hooks
needed a shell-free equivalent. Windows-side, `cmd.exe` does understand `||`, but
we cannot verify that Claude Code and Codex run hook commands through a shell on
Windows at all, so relying on it would be a guess.

## Decision

One platform dialect, `hookCliDialect()` in `src/shared/dev3-cli-path.ts`, carries
`{ cli, posixShell }` and every generator takes it as an injectable option
(`buildClaudeHooks`, `buildCodexHooks`, `buildCodexHooksConfigOverride`,
`buildClaudeSkillContent`/`buildCodexSkillContent`/`buildGenericSkillContent`,
`claudeBashPermission`). POSIX returns the frozen `~/.dev3.0/bin/dev3` with zero
filesystem probing, so its output is byte-identical to before. Windows resolves an
absolute `dev3.exe` from pure layout math (`windowsDev3CliCandidates`: bundled
`cli\dev3.exe` next to the real exec dir → `Resources\app\cli\dev3.exe` → 
`%USERPROFILE%\.dev3.0\bin\dev3.exe`), quoted only when the path contains spaces.

Tolerance without a shell is a new CLI flag, `--tolerate-app-offline`
(`TOLERATE_APP_OFFLINE_FLAG`): `src/cli/main.ts` passes it into
`exitAppNotRunning`, which still prints the whole "app not running" notice to
stderr but exits `0`. It is scoped to that single condition — every other failure
code is untouched — and no exit code changed, so the registry in
`src/shared/cli-exit-codes.ts` is unchanged.

`ensureDev3CliSymlink` now targets `dev3.exe` on Windows and degrades symlink →
copy → `dev3.cmd` shim, because a Windows symlink needs elevation or Developer
Mode. It still never throws.

## Risks

- What Claude Code and Codex accept on Windows is unverified: that a `Bash(<abs
  path> *)` permission rule matches the literal command prefix, that double
  quotes are the right quoting, and that a `!`-injected skill command runs at all.
  All three are assumptions; the shape is easy to change because it comes from one
  resolver.
- The Windows path is resolved when the generating process starts. If the app
  moves after the hooks are written, the worktree's stored absolute path goes
  stale until the hooks are regenerated (POSIX's `~` never had this problem).
- `src/shared/agent-skill-content.ts` still mentions `~/.dev3.0/bin/dev3` in
  prose inside the protocol body. It is advice to the agent, not an executed
  command, and belongs to a different owner — left for a follow-up.

## Alternatives considered

- **Keep `|| [ $? -eq 2 ]` and rely on `cmd.exe`** — plausible, but it assumes a
  shell we did not verify and violates the "no shell operators" requirement.
- **Drop the tolerance on Windows** — rejected: reintroduces the exact wedge
  decisions 032/089 fixed.
- **`DEV3_TOLERATE_APP_OFFLINE` env var instead of a flag** — setting it inline
  needs shell syntax, which is the thing we are removing.
- **Make `exitAppNotRunning` exit 0 globally** — rejected for the same reason as
  in decision 032: it lies to human users and scripts.
