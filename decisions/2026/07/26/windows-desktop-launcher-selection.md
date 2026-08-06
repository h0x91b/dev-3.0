# 176 — Select the Windows desktop launcher from `bin/launcher.exe`

## Context

`scripts/verify-windows-app-launch.ts` picked the desktop executable by scanning the
extracted bundle root for a single `*.exe`. That assumption never held for the Windows
package, so the `windows-app-archive` job failed on every recent Windows PR with
`Expected exactly one desktop executable at the bundle root; found 0: none` — the whole-app
launch proof was permanently red while the job stayed non-required.

## Investigation

Electrobun's `createAppBundle` (`node_modules/electrobun/src/cli/index.ts`) only uses the
macOS `Contents/MacOS` layout on macOS. For `win`/`linux` it puts the exec directory at
`<bundle>/bin`, and the Windows branch renames the copied launcher to `launcher.exe`
(PATHEXT workaround in the same file). `bun.exe`, `bspatch.exe` and `zig-zstd.exe` land in
that same `bin/`; the update tar contains exactly one top-level entry, the bundle folder.
Electrobun's own dev launch spawns `join(<bundle>/bin, "launcher.exe")` with
`cwd` set to that exec directory.

## Decision

`selectDesktopExecutable` now takes every bundle-relative `.exe` path and accepts only
`launcher.exe` inside `bin/` (or, tolerantly, at the bundle root). Anything else is
rejected with an explicit reason — `outside the bundle exec directory 'bin/'` for
`cli/dev3.exe`, the `native-host-image/` terminal host and setup carriers, `not the
electrobun desktop launcher` for the runtime binaries — and both "no candidate" and
"more than one candidate" throw with the full considered inventory. The launch step
resolves the selection inside the extracted bundle and starts it with
`cwd = dirname(launcher)`, matching electrobun. The executable inventory is written to
`artifacts/windows-app-layout.json` before selection so a future layout change uploads its
own evidence.

## Risks

The launcher basename is an electrobun implementation detail; if it is ever renamed the
check fails instead of silently launching the wrong binary — the error lists every
executable considered, which is the intended failure mode.

## Alternatives considered

- **Blocklist of known auxiliary executables** — rejected: a new helper binary in `bin/`
  would silently become "the desktop executable".
- **Pick the largest `.exe`** — rejected: `bun.exe` is by far the largest, and size is not
  a contract.
- **Search recursively for any single `.exe`** — rejected: the package ships several, so it
  cannot be deterministic.
