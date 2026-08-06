# 217 — Windows: free the build folder before Electrobun wipes it

Cite this record as `217-windows-build-folder-freed-before-electrobun-wipes-it`
— decision numbers in this repo are not unique, slugs are.

## Context

`bun run dev` cannot start on Windows. Every build dies in Electrobun's own
preamble:

```
EBUSY: resource busy or locked, rm 'D:\src\dev-3.0\build\dev-win-x64'
at runBuild (electrobun)
```

Everything before it succeeds — vite bundle, `dist/dev3.exe`, the native host
image. This blocks every other Windows fix, because none of them can be built.

## Investigation

Electrobun 1.18.1 `src/cli/index.ts` opens `runBuild` with
`if (existsSync(buildFolder)) rmSync(buildFolder, { recursive: true })` — no
`force`, no `maxRetries` — immediately after `runHook("preBuild")`. `bun run dev`
reaches it twice: once via `electrobun build` (`scripts/dev.ts` → `devPlan`) and
again inside `electrobun dev`. A clean tree skips the wipe, so the failure is
"something from the previous run is still alive", not structural.

Who holds the folder on Windows (macOS unlinks a running image happily, which is
why this is a one-platform defect):

- **The app itself.** `runApp` spawns `launcher.exe` with
  `cwd: build\<prefix>\<app>\bin`, and a live process's current directory cannot
  be deleted on Windows. Its image lives there too.
- **The packaged CLI.** `resolveDev3CliPath` (`src/shared/dev3-cli-path.ts`) makes
  Windows agent hooks invoke `<execDir>\cli\dev3.exe` — inside the build folder.
  A hook from **another worktree** therefore pins it, and some of those calls block
  for up to ten minutes waiting for user approval.
- **Detached native terminal hosts.** `nativeHostLauncher` used `node:child_process`
  `spawn` with no `cwd`, so every host inherited the app's bundle cwd — and hosts
  are deliberately detached to survive app restarts (decision
  `169-packaged-windows-native-host-image`). This was the load-bearing holder: with
  any task terminal alive, no amount of killing would have freed the folder.
- **Not a holder:** the host's *image* — it runs from the staged copy in
  `~/.dev3.0/native-host-images/<tag>/`, never from the install directory.

`process.chdir()` at app startup was rejected outright, and not on suspicion:
`src/bun/index.ts` already records that Electrobun resolves `views://` relative to
`process.cwd()`, so moving the process blanks the desktop window with "Resource not
found". It was tried before and the reason is written down.

That leaves the host cwd, and the rule for it already exists: decision
`110-no-chdir-pin-child-cwd` pins every cwd-less child to `DEV3_HOME` in
`spawn.ts` for exactly this hazard class (a bundle deleted from under a running
instance). The detached host launchers were the ONE HOLE in it — they call
`node:child_process.spawn` directly because they need `argv0`, so the wrapper never
saw them. This change closes that gap rather than inventing a policy.

`spawn.ts` and `src/bun/index.ts` both cited that rule as "decision 109", which is
three unrelated records; both now cite the slug. Numbers in this repo are reused —
cite slugs.

## Decision

Two parts, neither of which can be verified by an agent — no agent runs Windows.

1. **`detachedHostCwd()`** (`src/bun/native-terminal-registry/paths.ts`) returns
   `~/.dev3.0`, and both detached host launchers (`nativeHostLauncher` in
   `src/bun/native-host-runtime.ts`, `defaultHostLauncher` in
   `native-terminal-registry/registry.ts`) pass it as `cwd`. It is outside any app
   bundle, lives as long as dev3 has data, and the on-disk invariants in AGENTS.md
   forbid moving or deleting it. This removes the condition rather than cleaning up
   after it, and it kills nothing.
2. **`scripts/free-build-folder.ts`**, wired as Electrobun's `preBuild` hook. On
   any non-Windows host it returns before touching anything, so the macOS dev loop
   is byte-identical. On Windows it **attempts the delete first** — a machine holding
   nothing never runs a process query at all — and only after that fails does it
   enumerate, terminate the processes whose **own image** lives inside the build
   folder, and retry the delete.

Deliberate limits inside the hook:

- **The packaged `cli/dev3.exe` is never killed.** It may be serving a different
  task; the hook names it (best-effort `CommandLine` for attribution) and fails with
  a message that leaves the decision to the user.
- **No `taskkill /T`.** A detached host still records the app as its parent, so `/T`
  would take out live agent terminals. Every process worth killing matches by image
  path individually, so the tree flag buys nothing.
- **`tasklist.exe /FO CSV /NH` for the listing.** A native executable: no WMI
  service, no PowerShell cold start. A sibling task observed a Windows process
  enumeration stall for tens of seconds on a CI runner, and its evidence (n=1, one
  60 s budget) **cannot separate a stalled WMI round-trip from a stalled
  `powershell.exe` start**, and a later clean run consumed no retries at all, so it
  did not settle the question either — this avoids both halves rather than claiming
  immunity from one. `/NH` removes the localized header from the parse.
- **Bounded ATTEMPTS, not a longer timeout,** and every query logs the milliseconds
  it cost, so the next stall arrives with evidence. The bounds are `2 × 5 s`
  (listing) and `2 × 10 s` (paths).

  Sized against the only figures anyone has: on a Windows GitHub runner a WMI
  process-tree walk measured ~1965 ms mean / 3316 ms worst, and a `tasklist`
  liveness call 349 ms worst — about 6× cheaper per call (post-merge run
  `31100808763`, attempt 1). So the 5 s listing bound carries ~14× headroom over
  measured worst, and the 10 s path bound ~3× over the WMI worst. Two honest caveats:
  these are **ONE run's figures, not a distribution**, and the path query here is
  `Get-Process`, not WMI — no measurement of it exists, so the WMI worst is only the
  closest available proxy.
- **The retry path is unit-proven and field-unproven.** That run consumed zero
  retries in production, so nothing here has been exercised by a real stall — and the
  same run cannot separate a stalled WMI round-trip from a stalled `powershell.exe`
  start either. That discrimination stays open.
- **A zero-row parse is a failure, never "nothing is running".** Concluding the
  latter would report every owned process dead and clear nothing while claiming to.
- **The narrow path query is the only thing that authorizes a kill.** `tasklist`
  gives names, not paths, so names only select *candidates* (matched against the
  `.exe` files this build folder actually contains) and a single `Get-Process -Id
  <pids>` call confirms the real image path. A single-pid CIM call is used only to
  attribute a refused CLI to a task, and may fail silently.

**The app process keeps its own cwd inside the build folder, on purpose.** Nothing
here moves it (see above), so after this change the folder is still pinned while the
dev app runs — by the app itself, whose image also lives there. That is class one:
the hook terminates it and prints what it terminated, and the user is rebuilding it
anyway. What the fix removes is the pin held by processes we must NOT kill.

## Risks

- Nothing here is verified on Windows. macOS proves only the no-op branch and the
  pure selection logic (17 mutations, red/green each).
- Terminating the previous dev app is silent-by-intent but printed: the user is
  rebuilding it anyway.
- Hosts started **before** this change still carry the old bundle cwd, so the first
  build after upgrading can still refuse once until those tasks are restarted.
- **`scripts/free-build-folder.ts` is not in `WINDOWS_SCOPE_PATHS`** (`src/shared/
  windows-ci-scope.ts`), so a future change to the hook ALONE would merge with the
  packaged Windows proof skipped — a success that proved nothing. This change is in
  scope only because it also edits `electrobun.config.ts`, `src/bun/index.ts` and
  `src/bun/native-terminal-registry/**` (7 of its 13 files match). Reported to the
  coordinator; that list is held by another task, so it is not edited here.
- A holder that owns a handle without running from the folder (a shell or Explorer
  window sitting in it, an antivirus scan) cannot be enumerated at all; the hook
  fails with a message naming that as the cause.

## Alternatives considered

- **Retry the delete without killing** — a live app never releases the folder, so
  it only fails slower. Kept as the retry loop *after* killing.
- **Build into a per-run folder** (`build/dev-win-x64-<n>`) — rejected: the layout
  is assumed by the packaging scripts, the verify proofs, CI artifacts and the
  updater, and orphan folders would accumulate.
- **Patch or vendor Electrobun's `rmSync`** (`force` + `maxRetries`) — rejected: a
  fork to maintain, and it still cannot free a folder a live app is sitting in.
- **Kill by process name** (`bun.exe`, `dev-3.0.exe`) — rejected outright: that
  reaches every agent's Bun on the machine. Image path is the only trustworthy
  ownership signal.
- **`process.chdir()` at startup** — rejected, see Investigation.

## Related, established but NOT fixed here

The same Windows rule makes a worktree undeletable while any live process sits in
it, and `git worktree remove --force` runs on task completion. The teardown order
already guards it: `destroyTaskPty` awaits `destroyNativeTaskSession` (which waits
for the host tree to be gone) and `killDevServer` runs before `removeWorktree` —
deliberately, with a comment saying why. What remains is a race (handles released
just after exit) and any process with a cwd in the worktree outside the host's job
object; neither is established as occurring, and a failure surfaces loudly as
`Failed to remove worktree at …` rather than a silent leftover. Reported to the
coordinator instead of widened into this task.
