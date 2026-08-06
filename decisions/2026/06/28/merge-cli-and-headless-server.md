# 084 — Merge `dev3-server` into the `dev3` CLI (single binary, in-process headless)

## Context

We shipped two `bun build --compile` binaries: `dev3` (the CLI, `src/cli/main.ts`) and `dev3-server` (the headless backend, `src/bun/headless-bootstrap.ts` → `headless-entry.ts`). `dev3 remote` located and spawned `dev3-server` as a sibling process. Each binary embeds the full ~60 MB Bun runtime, so shipping both duplicated the runtime on disk, and the sibling-spawn path had real footguns: `locateServerBinary()` realpath/brew-symlink resolution, a "binary not found" failure mode, and possible version skew between the two artifacts.

## Decision

One binary. `dev3 remote` (`src/cli/commands/remote.ts → handleRemote`) now boots the headless server **in-process**: it sets `process.env.DEV3_HEADLESS = "1"` and then `await import("../../bun/headless-entry")`. Because `await import()` is a statement (not a hoisted declaration), the flag is guaranteed set before headless-entry — and the `electrobun-platform` shim it pulls in — evaluates, so the shim short-circuits to no-op stubs. This single path serves both dev (`bun run src/cli/main.ts remote` imports the TS source) and prod (Bun bundles the dynamic-import target into the compiled `dev3`). Removed: `dev3-server` from `build:cli`, `electrobun.config.ts` copy, `installBinary` in `src/bun/index.ts`, the Homebrew formula, the Dockerfile, and `src/bun/headless-bootstrap.ts` (deleted). This supersedes decision 035 (the dev-mode `isRunningViaBun`/`runViaBun` spawn dance is gone — there is no compiled server to avoid spawning).

## Risks

- The heavy backend must stay behind the dynamic import so the CLI hot path (`dev3 task move`, run every agent turn) doesn't evaluate it. Enforced by `src/cli/__tests__/cli-startup-graph.test.ts`, which walks the CLI's static import graph and fails if `headless-entry`/`remote-access-server`/`rpc-handlers`/`electrobun` become statically reachable.
- The compiled `dev3` is now ~the old `dev3-server` size (bundles the backend). That's disk only — startup latency is unchanged because the backend modules aren't in the startup graph.

## Alternatives considered

- **Keep two binaries.** Wastes ~60 MB dup runtime and keeps the sibling-locate/version-skew footguns for no real benefit; the app was already "light without --remote".
- **`dev3 remote` re-execs itself** (`process.execPath` with `DEV3_HEADLESS=1`). Preserves a separate PID but adds spawn + signal-forwarding for nothing — `dev3 remote` is a dedicated long-lived invocation, so in-process is strictly simpler.
- **One Bun runtime + two plain JS bundles (no `--compile`).** Dedups the runtime but loses the single-file install and adds a runtime-resolution step.
