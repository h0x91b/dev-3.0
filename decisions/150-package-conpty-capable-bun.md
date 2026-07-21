# 150 — Reuse the packaged Bun as the Windows terminal host

## Context

Electrobun 1.18.1 defaults every platform package to Bun 1.3.13, while the
Windows raw-PTY tracer needs Bun 1.3.14 or newer for `Bun.Terminal` ConPTY
support. A system Bun cannot help because package contents and in-app updates
must be self-contained.

## Investigation

| Strategy | Package size | Update behavior | Version skew | Maintenance cost |
|---|---|---|---|---|
| `build.bunVersion` override | Replaces the existing runtime; the 1.3.14 Windows baseline ZIP is 38,023,440 bytes versus 41,800,537 for 1.3.13, plus a host bundle under 20 KB | Normal Electrobun payload; a versioned, renamed copy outside the install directory can outlive an update | App and newly staged hosts share one explicit version; live older hosts require protocol negotiation | Low: one runtime pin, one host bundle, and one package proof |
| Electrobun upgrade | No duplicate runtime | Normal Electrobun payload | Framework and Bun advance together on Electrobun's schedule | Medium: broad framework regression surface |
| Standalone compiled host | Adds about 97.8 MB installed beside Electrobun's runtime (measured with Bun 1.3.14) | Needs its own signing, staging, update, rollback, and cleanup rules | App Bun, host Bun, and host protocol can all differ | High: a second Bun-bearing release artifact |

Electrobun 1.18.1 is the latest stable release investigated, and 1.18.4-beta.6
still pins Bun 1.3.13. Electrobun's Windows updater waits for every process named
`bun.exe` or `Bun Helper` before replacing the app, so directly re-entering the
installed `bun.exe` would block updates; copying it to a versioned external path
as `dev3-terminal-host.exe` avoids both that wait and installation-directory locks.
The size comparison uses Bun's official [1.3.13](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.13)
and [1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) assets; Bun
documents that `Bun.Terminal` uses [ConPTY on Windows](https://bun.sh/docs/runtime/child-process#terminal-pty-support).

## Decision

Set the global `build.bunVersion` in `electrobun.config.ts` to 1.3.14 and bundle
the stable `src/bun/native-terminal-host/main.ts` entrypoint. The Windows
post-build proof copies the package's actual `bun.exe` and entrypoint to a
versioned temporary directory, renames the runtime to `dev3-terminal-host.exe`,
then proves that executable re-enters detached and starts PowerShell through raw
`Bun.Terminal` with no Bun on `PATH`.

Future production native-host discovery must stage the same two files under an
additive immutable path keyed by the host artifact/protocol and Bun versions,
leave live older versions alone across updates, and negotiate versions before attachment.
This task does not connect that carrier to sessions: tmux remains the only
production backend and all existing defaults and persisted data stay unchanged.

## Risks

`build.bunVersion` is global, so macOS and Linux packages also move from Bun
1.3.13 to 1.3.14 and require the normal packaging gates. Renamed-runtime
execution is an explicit dependency guarded by the native Windows package proof;
future production staging will also need conservative cleanup that never removes
a version while one of its hosts is live.

The proof reports whether `bun:ffi` loads, so this carrier can support the
prototype's Job Object bridge, but that does not select Bun FFI for production
containment. A signed native helper remains an open alternative.

## Alternatives considered

An Electrobun upgrade was rejected because no qualifying stable or current beta
was available and the framework change would broaden the regression surface.
The standalone compiled host remains the fallback if renamed-runtime execution
regresses, but its approximately 97.8 MB installed cost and independent release
lifecycle are unnecessary while the package runtime can be safely staged.

Directly re-entering `bun.exe` inside the app was rejected because it blocks the
current updater and keeps files in the replaceable installation tree in use.
Parser/renderer integration is intentionally excluded: the proof handles raw
PTY bytes only, because ghostty-web has a separate negative-allocation-pointer
failure in Bun 1.3.14 terminal callbacks on Windows.
