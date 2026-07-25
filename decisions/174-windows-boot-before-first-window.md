# 174 — Windows boot: everything that runs before the first window

## Context

Seq 1295 needs a Windows `bun run dev` to open the dev3 window. Four things on the
boot path failed there before any window could exist, and each one alone is fatal:

1. `src/bun/paths.ts` computed `DEV3_HOME` from `process.env.HOME || "/tmp"`.
   Windows does not define `$HOME`, so the entire data root became `C:\tmp\.dev3.0`.
2. `startSocketServer()` binds a Unix domain socket via `Bun.listen({ unix })`.
   Windows has no such socket, and the call sits at module top level in
   `index.ts` — it throws before `openMainWindow()` is ever reached.
3. `getUserShell()` → `defaultLaunchShellPath()` threw when `%SystemRoot%` was
   unset, because the strict PowerShell resolver refuses to guess.
4. The `dev` / `start` package scripts were single POSIX shell lines using
   env-var prefixes, `$(...)` and `${DEV3_PORT0:-0}` — none of which PowerShell
   speaks — and resolved `vite` / `electrobun` as bare PATH executables, which on
   Windows are `vite.cmd` and a Node CJS file respectively.

## Investigation

The boot order in `index.ts` is: CLI-binary install → agent skills → shell rc →
`resolveShellEnv()` → CLI socket → pollers → `openMainWindow()`. Everything after
`resolveShellEnv()` and before the window is either already wrapped in a
`try`/`catch` or already fires-and-forgets with a `.catch` (`resolveTmuxBinaryAtStartup`,
`backup-exclusion`, `ensureCodexConfigFile`, `installAgentSkills`, and
`initNativeNotifications`, which returns early off Darwin). The CLI socket was the
only unguarded fatal call. `rehydrateTaskLifecycles()` and
`startRemoteAccessServer()` run *after* the window and already catch per item, so
neither was wrapped speculatively.

## Decision

- `resolveUserHome()` in `src/bun/paths.ts`: `$HOME` → `%USERPROFILE%` →
  `os.homedir()` → `os.tmpdir()`, normalised to forward slashes. `$HOME` stays
  first so POSIX and every `HOME`-overriding test are byte-identical. Forward
  slashes matter because `DEV3_HOME` is composed by string concatenation
  (`${DEV3_HOME}/logs`) across the codebase and mixed separators would break the
  prefix comparisons that decide whether a path is dev3-managed.
- `cliSocketTransportSupported()` in `src/shared/cli-socket-transport.ts` (zero
  imports, so boot and unit tests can reach it) is the **single seam** for Seq
  1296. `startSocketServer()` returns `null` there instead of throwing, and the
  GUI logs that CLI commands and agent hooks cannot reach this instance. Headless
  `dev3 remote` does the opposite and exits 1: the socket is its only control
  surface, so booting invisibly would be worse than failing.
- `defaultLaunchShellPath()` degrades to `powershell.exe` (a PATH lookup) when
  `%SystemRoot%` is absent. `windowsPowerShellPath()` still throws — strictness
  belongs in the resolver, not on the boot path.
- `scripts/dev.ts` replaces both shell one-liners with a process chain: no shell,
  and `vite` / `electrobun` resolved as files inside `node_modules`. `devPlan()`
  and `devRunEnv()` are pure and tested, including the `${DEV3_PORT0:-0}` default
  that decision 093 depends on.
- `index.ts` installs the bundle CLI under `cliBinaryName()` from
  `electrobun.config`, so the copy map and the boot-time install can never
  disagree about `dev3` vs `dev3.exe`.

## Risks

- On Windows every CLI-driven feature is dead until Seq 1296: agent hooks cannot
  move task status, and `dev3 …` commands cannot reach the app. This is logged as
  a warning at boot, not hidden.
- `DEV3_HOME` uses forward slashes while `path.join()` elsewhere yields
  backslashes, so a Windows path can be spelled two ways inside one process. Only
  the concatenated form is used for the data root today; reconciling the two is
  the remaining Seq 1295 storage-key work.
- `POSIX` behaviour when `$HOME` is unset changed from `/tmp` to `os.homedir()`.
  The app never runs that way, and it is strictly the better guess.

## Alternatives considered

- **Rewrite the socket path to a named pipe now.** Rejected: named pipes live in
  a different address space with no directory to enumerate, so CLI discovery
  needs redesigning — that is Seq 1296, and half-doing it here would ship a
  transport that silently finds nothing.
- **Keep the shell one-liners and add `dev:win`.** Rejected under the
  no-deprecation rule: two spellings of the dev loop drift, and the POSIX one
  would stay the only tested path.
- **Point `DEV3_HOME` at `%LOCALAPPDATA%` on Windows.** Rejected: `~/.dev3.0` is
  the documented, frozen layout; a different root on one platform would fork the
  data-layout contract for no benefit at this stage.
