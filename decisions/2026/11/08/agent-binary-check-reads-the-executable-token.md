# The agent binary check reads the executable token, and may answer "cannot tell"

## Context
`resolveAgentLaunchBinary` (`src/bun/agent-launch-availability.ts`) took the binary name as everything after the last `/` of the base command. For `env /opt/mise/shims/opencode mini` that is `opencode mini`, and the whole string was then tested as a file. The agent launched fine by hand in a terminal but dev3 refused it or parked it on the "Agent not found: opencode mini" retry pane (GitHub issue #2218). The same was true of every base command with more than one word, including `npx claude`, which `LaunchDialect.commandToken` documents as supported.

## Investigation
The launch treats a base command in exactly two ways (`commandToken`, `src/shared/platform-launch.ts`): a value that is one absolute path is quoted whole, spaces included; anything else is left alone and re-parsed as shell text. So `/opt/my tools/claude` is one path, while `env /opt/bin/opencode mini` is three words. A check that splits on any other rule disagrees with the launch.

## Decision
`agentCommandExecutable` (`src/shared/agent-command-executable.ts`) answers which program the shell will exec, with three outcomes:
- `path` — one absolute path, tested with `isExecutableFile`;
- `name` — a bare word, resolved through PATH;
- `unknown` — only the shell can tell: a variable or `~`, a command substitution, a relative path (the pane's cwd is a worktree that may not exist yet), a bash builtin such as `exec`, an unterminated quote.

For shell text it skips `VAR=value` assignments and looks through `env` and the options it understands (`-i`, `-`, `-u NAME`, `--unset=NAME`, `--`). The absolute-path rule lives in one exported helper, `isAbsoluteCommandPath`, that both `commandToken` and the parser call. `unknown` surfaces as `unverifiable` and never counts as missing: neither the launch-boundary check nor the retry wrapper fires.

## Risks
A command whose executable is `unknown` is not vetted, so a genuinely missing binary behind `exec` or `$HOME/…` starts a pane that fails in the shell — the behaviour before the launch-boundary check existed. Wrappers other than `env` are judged as themselves (`npx claude` checks `npx`), so a missing package behind a present wrapper is not caught. The retry pane still probes the binary's bare name on PATH, even when the command names it by path.

## Alternatives considered
Checking only the first word, without looking through `env` (`env` always exists, so nothing real is verified). Skipping the check for any multi-word command (drops the guard for the common `tool subcommand` shape). Asking a real shell with `command -v` (a subprocess per launch, and it still cannot see into a wrapper). Treating an unparsable command as missing (that is the bug: a false "not installed" blocks a launch that works).
