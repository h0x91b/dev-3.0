# Guard the Codex status hooks on a dev3 task env var

## Context

dev3 declares its six Codex status hooks in `~/.codex/config.toml`
(`buildDev3CodexHooksBlock` in `src/bun/codex-config.ts`). That file is a
user-level config layer, so Codex loads the declarations in every session on the
machine. A user who runs Codex in an unrelated repo gets `dev3 hook codex`
spawned on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`,
`PostToolUse` and `Stop` — where it reads the config, finds no dev3 task, prints
`{}` and exits. Reported as h0x91b/dev-3.0#1527 by @vit-pavlenko.

Reproduced on Codex 0.147.0 with an isolated `CODEX_HOME` in a directory with no
relation to dev3: **240–266 ms per hook event**, measured inside the hook around
the dev3 process; ~205 ms measured the way Codex spawns it, of which ~38 ms is
Codex's own shell. A tool call fires two to three of those events. It never came
close to the 5 s hook timeout on an idle machine, so the cost is latency, not
breakage.

Two conditions shape the severity. Codex skips hooks it does not trust, so the
leak only bites after the user has trusted the block once in the hooks browser
(before that it is a "new hook — review required" nag in every session). And the
block is delimited by marker comments: a copy whose opening marker is gone stops
matching the replace, so launches append more copies — the developer machine this
was investigated on carried the block twice, doubling the cost.

## Investigation

Codex discovers hooks from a managed system config, the user's `config.toml`, a
project `.codex` folder, session `-c` flags, and plugins
(`codex-rs/hooks/src/engine/discovery.rs`). None of the scoped sources works
here:

- Project layers are only walked from `cwd` up to the project root, and for a
  **linked worktree** Codex deliberately redirects the hooks folder to the main
  checkout (`root_checkout_hooks_folder_for_dir`, `codex-rs/config/src/loader/mod.rs`).
  A dev3 worktree's own `.codex/hooks.json` is never read, and there is no
  ancestor above the git root to place one in.
- Session flags were the previous mechanism and were abandoned because the
  argument did not survive the Windows command line (PR #1384).

So the declaration has to stay user-level, and the fix belongs in what the
command does when Codex wakes it up.

## Decision

`codexHookCommand` in `src/shared/agent-hooks.ts` wraps the invocation in an env
guard: `sh -c '[ -z "$DEV3_TASK_ID" ] || exec <cli> hook codex'`. `DEV3_TASK_ID`
is injected into every task pane by `buildAgentEnv`
(`src/bun/rpc-handlers/shared-pure.ts`), so a foreign session skips before any
dev3 process exists — measured 50 ms, of which ~38 ms is Codex's own shell.
Verified end to end inside a real Codex session: without the var, zero
invocations and no error; with it, all invocations as before.

The guard is POSIX-only. Codex derives the hook runner from the session shell
(`build_hooks_for_config`, `codex-rs/core/src/session/mod.rs`), which on Windows
is `cmd.exe /c` **or** `powershell -Command`, and no single expression is valid
in both. Windows keeps the bare command — and that position is now asserted, not
merely documented: `ensureCodexConfig` takes the dialect as an option, so
`codex-config.test.ts` runs its hook-block cases against both dialects on every
runner and the Windows case checks that no guard is written.

`ensureDev3HooksBlock` additionally collects `[[hooks.*]]` groups whose every
handler is dev3's own status handler, so an orphaned copy is absorbed instead of
duplicated. Two conditions make a group ours: the event is one of
`CODEX_STATUS_HOOK_EVENTS`, and every command carries the `hook codex`
subcommand — mentioning the CLI is not enough, because a hook the user wrote
themselves may call `dev3 task move` for their own reasons and collecting that
would delete their work. The edit is then re-parsed and compared against the
intended shape before it is kept — the same proof `pruneCodexProjectEntries` uses
— and a group the user mixed their own handler into is left completely alone.

## Risks

- A user whose `$SHELL` cannot run `sh -c '…'` would lose status hooks. Every
  POSIX shell we know of (sh, bash, zsh, fish) runs it; the command goes through
  an explicit `sh` rather than trusting the caller's syntax.
- Changing the command changes its trust hash, so a user who had trusted the old
  declaration sees it as "modified" and must trust it again. dev3's own launches
  are unaffected — they pass `--dangerously-bypass-hook-trust`.
- Windows sessions keep the leak. Named, not fixed.
- The content-based collection edits a file the user also owns. It only ever
  removes groups that are entirely our own status handler, on an event we
  declare, and bails out on any surprise. A first cut selected on "mentions the
  dev3 CLI" alone and would have deleted a user's own `dev3`-invoking hook.

## Alternatives considered

- **Make the CLI itself cheap.** The floor for the packaged binary is ~165 ms and
  it still spawns; a lazy-import refactor would shave latency without closing the
  leak.
- **Session `-c hooks={…}` flags.** Perfectly scoped, and exactly what #1384
  removed for breaking on Windows.
- **A per-task `CODEX_HOME`.** Scopes everything, but takes the user's auth,
  config and history away from their own Codex.
- **Drop the hooks.** They are how a Codex task moves across the board.
