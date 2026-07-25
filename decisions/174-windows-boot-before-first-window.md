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
- `emitsUpdateArchive()` in `src/shared/electrobun-build-env.ts` gates the
  `postPackage` archive proof. Electrobun runs that hook for `dev` too, but `dev`
  emits no `.tar.zst`, so the proof threw and failed `electrobun build` *after* it
  had otherwise succeeded — the window never opened. Found on a real Windows run,
  invisible on macOS because the proof exits early off win32. The check is
  one-sided on purpose: only `dev` is known-archiveless, and an unset or unknown
  environment stays strict so the release proof cannot become a silent no-op.
- `index.ts` installs the bundle CLI under `cliBinaryName()` from
  `electrobun.config`, so the copy map and the boot-time install can never
  disagree about `dev3` vs `dev3.exe`.

## Follow-up found by the first successful Windows launch

The window opened, React rendered — and the app stopped on the **System
Requirements** gate, which is what actually stood between it and the Dashboard:

- `process.env.PATH` was **undefined** in the app process, while `SystemRoot` read
  fine. Windows spells the variable `Path` and a JS env object need not fold the
  case, so every binary lookup (`Bun.which`, `resolveBinaryPath`, spawned
  children) searched an empty path and git reported "not found" despite being
  installed. `normalizeEnvPath()` in `src/shared/env-path.ts` aliases whatever
  casing exists onto `PATH`, in place, before any lookup runs; a still-missing
  PATH is logged with the env key NAMES (never values) so the cause is
  identifiable next time. The exact key is checked first, so POSIX is untouched.
- tmux was a REQUIRED binary and cannot be installed on Windows, making the gate
  permanently unpassable. It is now `optional` there — still listed and still
  shown as missing, because hiding it would misrepresent the terminal backend —
  and `App.tsx` passes on `installed || optional`.
- The install hints ARE commands: `xcode-select --install` and `brew install` on
  Windows are noise. git now offers `winget install --id Git.Git -e`, and tmux
  offers no command at all, so `installCommand` became optional and
  `RequirementsCheck` renders no empty code box or dead copy button.
- Unrelated but surfaced by the same run: the favicons vite emits to `dist/` were
  never in the electrobun copy map, so **every** launch on every platform failed
  three resource loads. macOS swallowed it; the Windows console printed it.

## Ctrl+C: the cost of inserting a parent process

Replacing the shell one-liner with `scripts/dev.ts` inserted a process between the
shell and electrobun, and that broke Ctrl+C: the parent died on SIGINT while the
electrobun CLI, the launcher and the app were orphaned — still attached to the
console, still logging after the shell had printed a new prompt.

Reproduced on macOS as well, which killed the first fix: signalling the direct
child does NOT cascade. After SIGINT the two electrobun CLI processes died while
the app launcher and the app process survived. So the script now owns the whole
tree — `taskkill /PID <pid> /T /F` on Windows (one recursive call), and on POSIX an
explicit `ps -Ao pid=,ppid=` walk, SIGTERM to every descendant, SIGKILL to
survivors after a 3s grace. The pids are enumerated BEFORE the first kill, because
they vanish as the tree dies. `SIGBREAK` replaces `SIGHUP` on Windows, which has
none, and Node throws `ERR_UNKNOWN_SIGNAL` for a name the platform does not know.

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
- **Treat the build environment as an exhaustive enum and throw on anything
  unknown.** Rejected: Electrobun types it `"stable" | "canary" | "dev" | (string
  & {})`, and this repo also builds with `--channel prod`, so an exhaustive check
  would fail release builds on a value that is legitimately open-ended.
- **Point `DEV3_HOME` at `%LOCALAPPDATA%` on Windows.** Rejected: `~/.dev3.0` is
  the documented, frozen layout; a different root on one platform would fork the
  data-layout contract for no benefit at this stage.

## Found by driving the real Windows machine (Seq 1295, second round)

Three defects only a live run could show, all fixed here:

1. **The storage key.** `projectSlug()` mapped `D:\src\dev-3.0` to itself —
   colon and backslashes included — which is not a legal directory name. The
   formula also existed as five hand-copied literals (git.ts, shared-images.ts,
   conversation-search-core.ts, app-handlers.ts, context.ts×3), so "keep them in
   lockstep" was unenforceable. `shared/project-storage-key.ts` is now the only
   copy: POSIX output is byte-identical to the frozen algorithm, and win32 gets
   an additive sanitised key (`D-src-dev-3.0`). Windows has no pre-existing
   `~/.dev3.0`, so nothing migrates.

2. **The remote UI served nothing.** `serveStatic` bounded the static root with
   `filePath.startsWith(staticRoot + "/")`, but `resolve()` returns backslashes
   on Windows, so the check failed for every file — including `index.html` —
   and the whole UI 404'd. Containment is now decided by `relative()`.

3. **Ctrl+C could wedge the console.** The Windows branch of `scripts/dev.ts`
   ran `taskkill /PID <electrobun child> /T /F` and then awaited `child.exited`.
   The desktop app is not always inside that tree — the launcher can leave it
   detached — so the kill missed it and the await never resolved, leaving a
   console that accepts no input. The wait now has a deadline.

Two environment facts worth recording for the next agent:

- **A desktop window cannot be created over SSH**: WebView2 fails with
  `HRESULT 0x80070578` (`ERROR_INVALID_WINDOW_HANDLE`) because an SSH session has
  no interactive desktop. GUI validation over SSH must go through the remote web
  UI; the native window needs a real interactive logon.
- **With no renderer, the quit gate never completes.** `before-quit` asks the
  renderer to confirm; when WebView2 failed there is nobody to answer and the app
  stays alive after a console shutdown signal. Not changed here — it is only
  reachable when the webview is already broken — but it is why the deadline in
  `dev.ts` matters.
