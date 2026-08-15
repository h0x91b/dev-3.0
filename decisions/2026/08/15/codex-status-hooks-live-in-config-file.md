# Codex status hooks live in config.toml, not in a `-c` argument

## Context

dev3 injected its Codex status hooks as one session flag, `codex -c 'hooks={...}'`, spliced into the
generated launch command by `applyAgentHooksToCommand` (`src/bun/rpc-handlers/tmux-pty.ts`). The
payload is dense with double quotes — `tomlInline` spells strings with `JSON.stringify`, and the hook
command is itself a quoted CLI path. On Windows every Codex session died before it began with
`invalid type: string "{SessionStart=[{matcher=startup|resume,...", expected struct HooksToml`:
Codex parses a `-c` value as TOML and falls back to treating it as a plain string when it does not
parse.

## Investigation

Two attempts to fix the quoting failed on a real windows-latest runner. PowerShell hands a native
process one flat command line, escapes nothing, and adds no quotes to a value that already contains
some; `CommandLineToArgvW` then eats the quotes and splits the value. A measurement round tried five
spellings (raw, escape-only, self-wrapped, `--%`, quote-free) and reported the argv each produced:
**none arrived intact**. Only the quote-free control survived, and a quote-free payload is not an
option — a hook command whose path contains a space parses, registers, lists, and then silently never
fires, which was verified against real codex.

That killed the argument as a delivery channel, so the question became which channel does not pass
through argv at all. Measured against codex-cli 0.147.0:

| Channel | Registered | Fires |
|---|---|---|
| `$CODEX_HOME/config.toml` | yes, `source: "user"` | yes |
| `$CODEX_HOME/<name>.config.toml` via `-p` | no | no |
| a linked worktree's `.codex/hooks.json` | no | no |

A file-declared hook arrives `trustStatus: "untrusted"`, and an untrusted hook is skipped in silence.
Trust can be granted two ways: a `[hooks.state."<key>"]` block in the same file (the hash covers the
hook definition, not the file, so adding the block does not invalidate it), or the
`--dangerously-bypass-hook-trust` launch flag. Both were verified end to end; the flag was chosen by
the user because the alternative costs an app-server round trip before every launch.

## Decision

`buildDev3CodexHooksBlock` (`src/bun/codex-config.ts`) serializes the hooks as TOML array-of-tables
between marker comments, and `ensureCodexConfig` replaces that block on every pass — dev3 already
owns this file for trusted projects, permissions and features, so this adds no new write surface. The
user's own `[[hooks.*]]` entries sit beside ours untouched, which is what an array of tables is for.
Commands go through `tomlBasicString`, so a Windows CLI path cannot break the file.

The launch command now carries the bare flag `--dangerously-bypass-hook-trust` instead of the
payload. It is feature-detected from `codex --help` (`supportsCodexHookTrustBypass`), never version-
gated, because a codex that does not know a flag exits 2 and the session never starts — the same
reasoning as `pickCodexProfileLaunchFlag`. When the probe says no, `setupAgentHooks` returns null and
logs a warning: the definitions are in place but nothing will fire, and no other signal would say so.

## Risks

The flag disables per-hook trust for dev3-launched Codex sessions, so a hook from any source in that
session runs unchecked. The exposure is narrower than it reads: project hooks are not registered from
a linked worktree at all (measured above), and dev3 always runs agents in one.

The hooks are declared globally, so they are also present in the user's own Codex sessions outside
dev3. `handleCodexHook` returns successfully without a `taskId` (`src/cli/commands/codex-hook.ts`),
making it a silent no-op there.

Codex versions predating the flag get no status transitions. Those versions predate hook trust as
well, so their file-declared hooks most likely fire without it — unverified, and the warning is the
signal if not.

## Alternatives considered

Writing `[hooks.state]` trust into the same file: proven to work, rejected as the costlier half of
the same route. Emitting TOML literal strings to drop quotes from the `-c` payload: rejected — a
quote-free hook command with a space in its path dies silently. Delivering hooks through the `-p`
profile file: measured, not a hook source. `--%`: swallows the rest of the command line.
