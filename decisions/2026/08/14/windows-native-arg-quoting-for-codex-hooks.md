# Quote native-process arguments for Windows argv, not just for PowerShell

## Context

dev3 injects its Codex hooks as one session flag: `codex -c 'hooks={...}'`, spliced into the
generated launch command by `applyAgentHooksToCommand` (`src/bun/rpc-handlers/tmux-pty.ts`).
On Windows, Codex refused every session with
`invalid type: string "{SessionStart=[{matcher=startup|resume,...", expected struct HooksToml`.

## Investigation

The payload is serialized by `tomlInline` (`src/shared/agent-hooks.ts`), which spells every string
with `JSON.stringify` — so it is full of double quotes — and on Windows the hook command itself is
a quoted absolute path (`hookCliCommandPath`). Comparing the payload dev3 generates with the value
Codex reported showed exactly one level of `"` removed everywhere.

That was reproduced away from Windows: taking the real payload on macOS, deleting its double
quotes and running `codex app-server --stdio -c <payload>` reproduced the identical error. Codex
treats a `-c` value it cannot parse as TOML as a plain string, which is why a type error names a
string at all.

The remaining link is not observable from this repo: Windows PowerShell 5.1 copies an argument into
a native process's command line without escaping it, and `CommandLineToArgvW` then consumes every
`"` it finds.

## Decision

`LaunchDialect` gained `quoteNativeArg` (`src/shared/platform-launch.ts`) next to `quote`. POSIX
binds it to the same `posixShellQuote`, so macOS and Linux output is byte-identical. Windows wraps
the value in `windowsNativeArgEscape` first, which rewrites `"` as `\"` and doubles any run of
backslashes immediately in front of one — the spelling that survives both PowerShell and the argv
parser. Only the Codex `-c` splice uses it, via `shellQuoteNativeArg` in `shared-pure.ts`.

`src/bun/__tests__/codex-hooks-windows-argv.test.ts` spawns real PowerShell on windows-latest,
running the line `announceAndRun` actually generates, and asserts a real process received the
payload byte-for-byte; a second case asserts the pre-fix quoting still loses the quotes, so a green
result cannot come from a probe that sees nothing.

## Risks

`windowsNativeArgEscape` deliberately does not double a trailing run of backslashes. Whether that
run needs doubling depends on whether PowerShell wraps the argument in quotes, which it decides from
the value's own whitespace — undecidable here. The hooks payload always ends in `}`, so the case
cannot arise for this caller; a future caller with a value ending in `\` needs the question reopened
rather than assumed.

Nothing broken persists on disk: the override is session-scoped and never written to a config file,
so an already-installed user is fixed by the next launch.

## Alternatives considered

Emitting TOML literal strings (`'...'`) to avoid double quotes entirely — rejected because the
Windows hook command must itself quote the CLI path, so quotes cannot be removed from the payload.
PowerShell's `--%` stop-parsing token — rejected because it swallows the rest of the command line,
including the prompt and model flags.
