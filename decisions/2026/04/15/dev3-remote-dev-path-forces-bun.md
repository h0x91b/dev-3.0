# 035 — `dev3 remote` in dev mode always runs from source, ignoring `dist/dev3-server`

> **Superseded by [084](084-merge-cli-and-headless-server.md).** `dev3-server` no
> longer exists as a separate binary — `dev3 remote` boots the headless server
> in-process via a dynamic import, so the `isRunningViaBun`/`runViaBun`/
> `locateServerBinary` spawn dance described below has been removed. Kept for
> historical context.

## Context

`dev3 remote` spawns a separate `dev3-server` process (headless entry, no Electrobun GUI). In prod that binary sits next to `dev3`. In dev (`bun run src/cli/main.ts remote`) the original implementation also looked at `./dist/dev3-server` as a fallback.

## Investigation

First dev-mode test produced zero output. With stderr probes we observed:

```
child spawned pid=56990
child exit code=null signal=SIGKILL
```

Two root causes, both hostile to dev:

1. **macOS Gatekeeper** kills unsigned Bun compiled binaries on Sequoia 24.6 with SIGKILL immediately on spawn, no stdout/stderr. `dist/dev3-server` built locally by `bun build --compile` has no Developer ID signature, so every dev run died silently.
2. **Stale artifacts.** `dist/dev3-server` reflects whatever was last built — after editing source, running `bun run src/cli/main.ts remote` would silently execute the *old* compiled server, making the dev loop lie about what code is running.

## Decision

In `src/cli/commands/remote.ts → handleRemote()`, when `process.execPath` ends with `/bun` (or `\bun.exe` on Windows) — i.e., the CLI itself was launched via `bun run` — we always call `runViaBun(childEnv)` and never consult `locateServerBinary()`. Prod path (compiled `dev3` binary, `process.execPath` is the `dev3` binary itself) continues to look for its sibling `dev3-server`.

Helper: `isRunningViaBun()`. See `src/cli/commands/remote.ts`.

## Risks

- Detection is string-based on `process.execPath`. If someone renames the Bun binary to something else (e.g., packaged as `/usr/local/bin/dev3-runtime`), the check would mis-classify. Acceptable: that's not a supported setup.
- Windows detection (`\bun.exe`) is untested — dev-3.0 is macOS/Linux primary. If we ever ship Windows, revisit.

## Alternatives considered

- **Detect SIGKILL and retry via Bun.** Wasteful: we'd spawn a doomed child every dev run. Fails-slow vs fails-fast.
- **Require `DEV3_REMOTE_FORCE_DEV=1` env in dev.** Extra knob for the user to remember. `bun run` is already an unambiguous dev signal.
- **Strip the `./dist/dev3-server` fallback and stop there.** Would regress cases where someone runs the *compiled* `dev3` from a checkout whose sibling `dev3-server` happens to be missing. Keeping `locateServerBinary()` for prod preserves that.
