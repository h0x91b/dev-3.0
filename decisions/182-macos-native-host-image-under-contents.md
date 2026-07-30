# 182 — The macOS native host image lives at `<bundle>.app/Contents/native-host-image/`

## Context

The packaged native terminal host (decision 169) only ever shipped on Windows:
`scripts/build-windows-terminal-host.ts` exited outside win32 and the Electrobun
`postBuild` proof did the same. A packaged macOS build therefore carried no
`native-host-image/`, so `resolveNativeHostRuntime()` fell through to the
source-checkout branch — unreachable from a bundled app — and an explicitly
native task sat in Preparing behind an honest `NativeHostRuntimeError` (seq 1311).

Making the image ship on macOS needs one decision the other platforms did not:
*where*. Electrobun emits `<bundle>.app/Contents/MacOS/bun` for the runtime and
`<bundle>.app/Contents/Resources/app/` for everything in `build.copy`, while
Linux and Windows put the runtime at `<bundle>/bin/bun[.exe]` with copies under
`<bundle>/Resources/app/`.

## Investigation

`packagedHostImageRoots()` probes exactly two directories: the packaged runtime's
own directory and its parent. On Linux and Windows those are `<bundle>/bin` and
`<bundle>`, which is why `<bundle>/native-host-image/` already worked. On macOS
they are `Contents/MacOS` and `Contents` — so `Resources/app/native-host-image/`,
the "obvious" home next to the other copied assets, is **not reachable** without
a darwin-specific third probe.

`Resources/app` is also the directory Electrobun packs into `app.asar` when
`useAsar` is enabled, deleting the original tree. An image inside an archive
cannot be executed.

## Decision

Assemble the macOS image into `<bundle>.app/Contents/native-host-image/<tag>/`.
`nativeHostPackageLayout()` in
`src/bun/native-terminal-registry/host-images/package-layout.ts` owns the per-OS
split and is held to the "runtime directory or its parent" invariant by its own
test, so `resolveNativeHostRuntime()` needed no change at all.

The runtime carrier inside the image is `dev3-terminal-host` on POSIX and stays
`dev3-terminal-host.exe` on Windows (`packagedHostRuntimeCarrier()`), because the
Windows proof asserts that name as the detached host's Task Manager image name.

## Risks

`Contents/native-host-image/` is not one of Apple's standard bundle directories.
`electrobun.config.ts` currently sets `codesign: false` and `notarize: false`, so
nothing validates the layout today — but if macOS signing is ever enabled, a
non-standard directory at the `Contents/` level is the kind of thing `codesign
--deep` and Gatekeeper complain about, and the ~60 MB Bun carrier inside it would
have to be signed as a nested executable. Whoever turns signing on must revisit
this placement rather than assume it survives.

Second risk: the image duplicates the packaged Bun runtime, so every macOS and
Linux package grows by roughly the size of Bun. That is the same cost Windows
already pays and is inherent to an immutable image that must survive an in-app
update swapping the install directory.

## Alternatives considered

* **`Contents/Resources/app/native-host-image/`** — sits with the other copied
  assets and is codesign-friendly, but needs a darwin-only third probe root in
  `packagedHostImageRoots()` and would be swallowed by asar packing.
* **Ship the image via the `dist/native` copy rule** — no `postBuild` hook at
  all, but the carrier has to be the Bun runtime Electrobun copies into the
  bundle, which does not exist until after the copy step runs.
* **Symlink the carrier at the packaged `bun`** — halves the package size, but a
  live host would follow the link into an install directory an update replaces,
  which is the exact failure the immutable image exists to prevent.
