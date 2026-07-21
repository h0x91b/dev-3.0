# 150 — Reuse the packaged Bun as the Windows terminal host

## Context

Electrobun 1.18.1 defaults every platform package to Bun 1.3.13, while the
Windows raw-PTY tracer needs Bun 1.3.14 or newer for `Bun.Terminal` ConPTY
support. A system Bun cannot help because package contents and in-app updates
must be self-contained.

## Investigation

| Strategy | Package size | Update behavior | Version skew | Maintenance cost |
|---|---|---|---|---|
| `build.bunVersion` override | Replaces 117,660,760-byte Bun 1.3.13 with 98,480,216-byte Bun 1.3.14, plus a host bundle under 20 KB; no duplicate runtime | Normal Electrobun payload; a versioned, renamed copy outside the install directory can outlive an update | App and newly staged hosts share one explicit version; live older hosts require protocol negotiation | Low: one runtime pin, one host bundle, and one package proof |
| Electrobun upgrade | No duplicate runtime | Normal Electrobun payload | Framework and Bun advance together on Electrobun's schedule | Medium: broad framework regression surface |
| Standalone compiled host | Adds a 98,487,296-byte executable beside Electrobun's runtime | Needs its own signing, staging, update, rollback, and cleanup rules | App Bun, host Bun, and host protocol can all differ | High: a second Bun-bearing release artifact |

Electrobun 1.18.1 is the latest stable release investigated, and 1.18.4-beta.6
still pins Bun 1.3.13. Electrobun's Windows updater waits for every process named
`bun.exe` or `Bun Helper` before replacing the app, so directly re-entering the
installed `bun.exe` would block updates; copying it to a versioned external path
as `dev3-terminal-host.exe` avoids both that wait and installation-directory locks.
The installed-size comparison uses Bun's official [1.3.13](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.13)
and [1.3.14](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14) Windows x64 executables and a Windows x64 standalone host compiled from the same entrypoint with Bun 1.3.14; the official runtime ZIPs are 42,078,521 and 38,366,737 bytes respectively, while the compiled host ZIP is 38,365,009 bytes.
Bun documents that `Bun.Terminal` uses [ConPTY on Windows](https://bun.sh/docs/runtime/child-process#terminal-pty-support).

## Decision

Set the global `build.bunVersion` in [`electrobun.config.ts`](../electrobun.config.ts)
to 1.3.14; [`build-windows-terminal-host.ts`](../scripts/build-windows-terminal-host.ts)
bundles the stable host entrypoint. The [`start()` and `runHost()`](../src/bun/native-terminal-host/main.ts)
lifecycle stages through `dev3-terminal-host.exe`, while
[`verify-packaged-windows-conpty.ts`](../scripts/verify-packaged-windows-conpty.ts)
proves detached re-entry, same-PID reattach, clean stop, and raw PowerShell
`Bun.Terminal` with no Bun on `PATH`.
The packaged tracer runs that proof from its final Electrobun update archive;
the package workflow also builds the same global Bun pin on macOS and Linux.

Future production native-host discovery must stage the same two files under an
additive immutable path keyed by the host artifact/protocol and Bun versions,
leave live older versions alone across updates, and negotiate versions before attachment;
this task does not connect that carrier to sessions, so tmux remains the only
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
regresses, but its approximately 98.5 MB installed cost and independent release
lifecycle are unnecessary while the package runtime can be safely staged.

Directly re-entering `bun.exe` inside the app was rejected because it blocks the
current updater and keeps files in the replaceable installation tree in use.
Parser/renderer integration is intentionally excluded: the proof handles raw
PTY bytes only, because ghostty-web has a separate negative-allocation-pointer
failure in Bun 1.3.14 terminal callbacks on Windows.
