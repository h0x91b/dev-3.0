# Selectable POSIX shell, and why the golden wrappers moved

## Context

dev3 assumed `/bin/zsh`. `defaultLaunchShellPath` fell back to it, `getSupportedShell`
recognised only bash and zsh, and a shell outside that pair was skipped entirely: no
login-env import (so no PATH for agents and MCP servers) and no rc file to put `dev3` on
PATH. On macOS that is invisible — zsh always exists. On a minimal Linux box neither zsh
nor bash may be installed, and `/bin/sh` is dash or busybox ash. Every one of those
assumptions is a dead terminal there.

## Decision

One pure resolver, `src/shared/posix-shell.ts` (`resolvePosixShell`), decides which shell
runs, with filesystem probing injected so the decision table is testable. The
`terminalShell` app setting feeds it: undefined means auto-detect (login shell, then the
first installed of zsh → bash → sh), and an explicit `zsh` / `bash` / `sh` that is not
installed falls back down that same order and reports `fellBack` — the Settings screen
(Terminal → Shell) names the shell actually running instead of failing silently. Default
is auto, not a literal zsh: pinning zsh would have switched existing bash users' terminals
on upgrade.

`shell-env.resolveUserShell()` owns the answer, caches it for an hour, and publishes it to
the launch dialect via `setPosixDefaultShell` — the dialect is shared code with no access
to settings, and terminals and generated wrapper scripts must not disagree about which
shell they run.

Three shell-level changes follow:

- `getShellRcFiles` writes the PATH line to `~/.profile` for `sh` (dash reads no other rc
  on login).
- `shell-init.ts` writes a `.shrc`, reached through `$ENV` (set in `tmux/config.ts`, which
  also forwards the user's own `$ENV` as `DEV3_USER_ENV`). Verified against real
  `/bin/dash`: it does expand command substitution in `PS1`, so the sh prompt carries the
  same worktree-relative path and git branch as the bash one.
- `resolveShellEnv` retries the env dump as `-lc` when the `+m -ilc` form is refused —
  that dump is what puts PATH into every agent session, so it must not fail closed.

## Risks

The POSIX golden wrappers changed on purpose, which the golden test's own doc warns
against: `command -v x &>/dev/null` became `>/dev/null 2>&1` (a POSIX sh reads `&>` as
"background, then redirect", so the guard always passed), and `readKey` grew an `sh` arm.
That arm loses "press any key to close now": dash has neither `read -n`/`-k` nor `read -t`,
so with a timeout it sleeps out the countdown and without one it waits for a whole line.
Both are cosmetic next to a syntax error in the pane. macOS and existing zsh/bash users see
byte-identical behaviour — only the branch they never take moved.

`resolveUserShell` reads `loadSettingsSync()` on first use, so `shell-env` now imports
`settings`. Suites that mock `node:fs` module-by-module can trip on that; `shell-env.test.ts`
mocks `../settings` and `../executable` for exactly this reason.

## Alternatives considered

- **Push the preference in from each entry point** instead of reading settings inside the
  resolver: no new import, but every future entry point (CLI, e2e harness, headless) has to
  remember, and `getUserShell()` already runs before the app's settings load.
- **Respect the choice literally and let a missing shell fail** — honest, but a Linux user
  who picks zsh by mistake gets dead panes and no explanation.
- **Leave `defaultLaunchShellPath`'s `/bin/zsh` last resort alone.** It is only reached with
  no override and no `$SHELL`, but that is precisely the bare Linux case it breaks; `/bin/sh`
  is the only path POSIX guarantees.
