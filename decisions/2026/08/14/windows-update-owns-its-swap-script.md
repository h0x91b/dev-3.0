# dev3 owns the Windows update swap script, and the layout goes side-by-side next

## Context

2026-08-14 was the first time in this project's history that anyone observed the Windows
updater run at all. It hung: a `cmd.exe` window, black, one cursor, zero output. Killing
the leftover `launcher.exe` processes released it and the new build started by itself.

Reading `node_modules/electrobun/dist/api/bun/core/Updater.ts` (electrobun 1.18.1)
explains it exactly. `applyUpdate()` writes `update.bat` and runs it through Task
Scheduler. The script waits in a loop on:

```
tasklist /FI "IMAGENAME eq launcher.exe" … && goto waitsleep
tasklist /FI "IMAGENAME eq bun.exe"      … && goto waitsleep
tasklist | find /I "bun Helper"          … && goto waitsleep
```

Those are **image names**, matched across the whole machine, not the process that is
actually updating. One stale launcher from an earlier session — or any unrelated Bun —
loops forever. `@echo off` plus every command redirected to `nul` is why the window shows
nothing, so a wedged update and a working one look identical.

Two facts settled before designing paths:

- Electrobun's `appDataFolder` on Windows is `%LOCALAPPDATA%\<identifier>\<channel>`
  (`getAppDataDir()` reads `LOCALAPPDATA`). It is **not** under `~/.dev3.0`, so the
  on-disk invariants in AGENTS.md do not govern this tree.
- `launcher.exe` resolves `bun.exe`, `../Resources/main.js` and its cwd from
  `std.fs.selfExeDirPath` (upstream `package/src/launcher/main.zig`). It is coupled to
  the version tree it sits in and **cannot** be hoisted out of it.

## Decision

`doApplyUpdate()` in `src/bun/updater.ts` branches on `win32` to
`src/bun/windows-update/apply.ts` instead of `Updater.applyUpdate()`. macOS and Linux are
untouched. The script is built by the pure `buildWindowsSwapScript()`
(`src/bun/windows-update/script.ts`), which:

1. waits on `tasklist /FI "PID eq <our pid>"` — the process that is actually updating;
2. gives up after a bounded 60s and then force-closes **only** processes whose executable
   path is inside the folder being replaced (`Get-Process | Where-Object Path -like`);
3. echoes every step to the console and to `dev3-update.log`, and keeps the window open
   with the reason when a step genuinely fails.

Arseny picked the **side-by-side versioned layout** (`versions\<build>\` + a pointer,
Chrome/VS Code shape) over renaming `app` aside, and was told it costs more work. It is
deliberately **not** in this change: the coordinator split it out so the hang stops
biting on his working box today, while canary publishes every ~20 minutes. Because the
launcher cannot be hoisted, the pointer will be the Desktop and Start Menu `.lnk`
shortcuts, rewritten on each update — Arseny chose that over shipping a new stable
launcher binary or a `.cmd` entry point.

The rejected alternative for the layout stays rejected: renaming `app` aside and
unpacking the new tree under the same name, because whether a directory holding a running
executable can be renamed at all was never verified.

## Risks

- This change still overwrites `{appDataFolder}\app`, so a process holding a lock in that
  tree can still fail the update — it now **says so and stops** instead of hanging
  silently. Only the versioned layout removes the failure mode by construction.
- The force-close is a real kill. It is scoped by executable path to the tree being
  replaced, which is exactly the set of processes that would block the swap.
- Task Scheduler is kept rather than a detached child: it is the one part of the old
  handover we know executed on a real Windows box.

## Alternatives considered

- **Patch electrobun's `update.bat` in place.** Impossible — the script is a template
  literal inside `applyUpdate()`, with no seam.
- **Ship the versioned layout in the same change.** Rejected by the coordinator on
  timing: the hang is hitting a live box now, and the layout needs shortcut rewriting and
  its own Windows proof.
- **A directory junction at `app` retargeted per version.** Rejected: whether the
  junction can be replaced while a process runs through it is unverified, which is the
  same unknown that got the rename approach rejected.

## Verification

`src/bun/windows-update/__tests__/script.test.ts` guards the script's shape and was
mutation-verified on macOS: re-adding the `IMAGENAME` wait, removing the bounded give-up,
and silencing the wait loop each turn it red.
`src/bun/windows-update/__tests__/swap.win-e2e.ts` **executes** the script on
`windows-latest` against a live process — once where it exits on its own, once where it
never does — and asserts the swap lands and the new launcher starts either way.
