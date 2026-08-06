# 214 — We embed the Windows icon ourselves, because electrobun structurally cannot

## Context

Every Windows build — local and CI alike — shipped executables with the default
Windows icon. The build printed three warnings and succeeded:

```
Warning: Failed to embed icon into launcher.exe: ResolveMessage: Cannot find module
  'D:\a\electrobun\electrobun\package\node_modules\rcedit\package.json' from 'B:\~BUN\root\electrobun'
```

Observed on a developer's Windows machine and, identically, in CI run
`31094889632` (`windows-app-archive`, 2026-08-06) for `launcher.exe`, `bun.exe`
and the self-extracting installer.

## Investigation

`D:\a\electrobun\electrobun\package` is a GitHub Actions workspace on **electrobun's
own** CI — it never existed on our machines. The reason it is baked in at all:

- The `electrobun` CLI we run is **not** `node_modules/electrobun/src/cli/index.ts`.
  That source ships for reference. `bin/electrobun.cjs` downloads and executes
  `bin/electrobun{.exe}`, a `bun build --compile` standalone binary built on their CI.
- Inside a standalone binary, `require.resolve("rcedit/package.json")`
  (`src/cli/index.ts:2594`, `:2693`, `:4880`) is resolved at **compile** time and
  frozen. `B:\~BUN\root` in the error is Bun's virtual root for such binaries —
  the tell that the path is embedded, not looked up.
- `png-to-ico` survives because it is pure JS and got bundled in. `rcedit` cannot
  be: it is a native `.exe` that must exist on disk.
- All three call sites wrap the failure in `try { … } catch { console.warn(…) }`,
  so a step whose only purpose is embedding the icon fails and reports success.

**Therefore patching is not an option**, not merely a worse one: the executed code
is a compiled binary we do not build, and `bun patch` on the shipped source changes
nothing.

## Decision

**We own the icon embedding, and we prove it by reading the bytes back.**

1. `rcedit` and `png-to-ico` become our own `devDependencies`. Both were already in
   `bun.lock` as electrobun's transitive deps, and `rcedit` ships
   `bin/rcedit-x64.exe` **inside its npm tarball** — so this adds no external binary
   and no PATH assumption, which is the rule this repo was burned by in the
   `tmux@3.6` incident (`105-pin-tmux-3.6-vendored-keg.md`).
2. `scripts/embed-windows-icons.ts` runs from the existing `postBuild` hook on
   Windows (`scripts/package-native-host.ts`), after electrobun's failed attempt and
   **before** the bundle is archived, so the fix reaches the update archive, the
   downloadable tree and anything extracted from the installer.
3. `src/bun/windows-icons/pe-icon-resources.ts` parses the PE resource table and
   requires **both** `RT_ICON` and `RT_GROUP_ICON`. An `rcedit` exit code of 0 is not
   evidence — this defect is precisely a step that exits 0 and writes nothing.
4. `resolveIconTargets` / `assertIconsEmbedded` assert an exact count of **2**
   (`bin/launcher.exe`, `bin/bun.exe`) and fail loudly on an empty or short list. A
   verifier that iterates nothing otherwise passes silently, which is the failure
   mode this whole change exists to remove.
5. Hard only where a human receives the result: the gate is the existing
   `emitsUpdateArchive()` from `src/shared/electrobun-build-env.ts`. A plain local
   build prints one line naming the cause and the fix instead of dying over a
   cosmetic icon — the supported Windows dev loop was already broken for an
   unrelated reason and must not be made stricter on top of an outage.

## The installer keeps no icon, permanently and on purpose

Electrobun builds the self-extracting installer **after** `postBuild`, from its own
extractor stub, then wraps it in a zip. Our hook structurally cannot reach it, and we
decline to reach into that zip.

`213-downloadable-windows-build-is-the-launched-tree.md` records that the installer
is built, **never launched by anything**, and deliberately not handed out; the
downloadable artifact is the tree the launch proof started. Giving the one unvetted
artifact an icon would make it read as finished. A user who eventually runs the
installer still gets an icon'd app — it extracts the tree we fixed. Only the
installer's own file icon stays blank.

**So every Windows build log keeps exactly one `Failed to embed icon` warning,
forever.** That surviving line is this decision, not a leftover. Do not "finish the
job".

## How the two-line `bun.lock` diff was produced

Not by `bun install`. Public npm is unreachable from the machine this was written on
(`ConnectionRefused` in milliseconds, not a timeout), and the local workaround — an
`.npmrc` pointing at an internal Artifactory mirror plus an isolated `HOME` — does
install, but rewrites the **resolution URL of every package in `bun.lock`** to that
mirror: 983 changed lines for a two-line dependency add. Committing that would point
CI at a host it cannot reach.

Both packages were already in `bun.lock` as electrobun's transitive dependencies, at
exactly the versions wanted. Promoting them to direct dependencies therefore needs no
new resolution at all:

1. Add them to `package.json`.
2. `git checkout bun.lock` — discard the mirror-poisoned rewrite entirely.
3. Add the same two lines by hand to the **workspace** `devDependencies` block of
   `bun.lock`. The package entries already exist further down with an empty
   resolution field, which is what "resolve from the default registry" looks like.

`bun install --frozen-lockfile` then reports `no changes`, and that is the evidence
this edit is sound: the flag makes bun refuse to write the lockfile, so a `package.json`
and a `bun.lock` that disagreed — a missing entry, a version mismatch, an unsatisfiable
range — would fail instead of being silently repaired.

**The honest caveat: CI is the first environment with real npm access.** If CI's
`bun install --frozen-lockfile` disagrees, that disagreement is about this hand edit.
Re-derive it from the three steps above rather than debugging it as a fresh mystery.

## Risks

- **rcedit only runs on Windows.** The hook is reached only from the `win32` branch
  of `postBuild`; a cross-build from macOS would skip it silently. No such build path
  exists today, and Windows packaging runs on `windows-latest`.
- **A future electrobun release may fix its own resolution.** Then both it and this
  hook embed the same icon into the same files — idempotent, wasteful, harmless. The
  assertion keeps working either way.
- **The bundle layout is hardcoded** in `WINDOWS_ICON_TARGETS`. A rename fails the
  build with a message naming the constant to update, rather than quietly proving
  fewer files.
- **The parser and its fixtures share one author's reading of the PE layout.**
  Mitigated by `pe-icon-resources-real-binary.test.ts`, which reads the real
  `rcedit-x64.exe`. That covers only the "no icon" direction — the repo carries no
  icon-bearing `.exe` for the positive one.

## Alternatives considered

- **Patch or pin around upstream.** Inapplicable, not just worse — see Investigation.
- **Report upstream and ship iconless builds.** Reported separately, but accepting it
  means every Windows user downloads, installs and runs something with the blank
  default icon for an unknown number of months. Fixing does not have to wait on it.
- **Fork electrobun's CLI.** Would fix it at source and make us responsible for
  building and hosting a 60 MB binary for three platforms. Wildly out of proportion.
- **Also re-embed into the installer by rewriting electrobun's zip.** Rejected — see
  the section above; it would dress up the unproven artifact.
