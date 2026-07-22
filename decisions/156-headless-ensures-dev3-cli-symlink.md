# 156 — Headless `dev3 remote` ensures the `~/.dev3.0/bin/dev3` symlink

## Context

Agent lifecycle hooks, the injected dev3 skill, and lifecycle `onExitCommand`s all invoke the CLI by a **hardcoded absolute path**, `~/.dev3.0/bin/dev3` (`DEV3_CLI` in `src/shared/agent-hooks.ts`; also `agent-skills.ts`, `lifecycle/executor.ts`). That path is not resolved through `PATH`, so it must be a working executable regardless of how the box was installed.

## Investigation

On a headless Linux box installed via Homebrew, every hook failed with `/bin/sh: 1: /home/coder/.dev3.0/bin/dev3: not found` even though `ls ~/.dev3.0/bin` showed `dev3` and `which dev3` returned `/home/linuxbrew/.linuxbrew/bin/dev3`. That combination (name present, `which` skips it, exec says "not found") is a **dangling / non-executable** entry. Root cause: only the GUI entry (`src/bun/index.ts` → `installBinary("dev3")`, copies on every launch) and the Settings toggle (`installDev3Cli`, symlinks) ever create/refresh that file. `src/bun/headless-entry.ts` — the `dev3 remote` server, the *only* entry point on a headless box — did neither, so the path was left as a stale leftover.

## Decision

Added `ensureDev3CliSymlink(dev3Home, execPath)` in `src/bun/cli-self-install.ts` and call it early in `headless-entry.ts` startup. It `realpathSync`-resolves the running binary (following brew's `bin → libexec` indirection, and guaranteeing the source is a concrete file, never the `<bin>/dev3` symlink itself), then symlinks `~/.dev3.0/bin/dev3` at it — recreating a missing/dangling/stale entry, no-op when already correct. Best-effort: all failures are logged and swallowed so they never block the server.

## Risks

- After a `brew upgrade` the resolved Cellar path changes, so the symlink dangles until the next `dev3 remote` (re)start — acceptable because a restart is already required to run the upgraded server (the in-app updater is stubbed in headless mode).
- Self-link (ELOOP, cf. decision 105) is avoided by resolving the source with `realpathSync` and skipping when `source === dest`.

## Alternatives considered

- Copy the binary like `index.ts` does — robust against the source moving, but a ~large copy on every start and no clear source path in the brew/FHS layout (`libexec/dev3`, no `cli/dev3`). Symlinking matches the existing `installDev3Cli` and tmux-shim patterns for `~/.dev3.0/bin/*`.
- Make hooks call `dev3` from `PATH` instead of the absolute path — rejected: hooks run in a minimal shell env, and the absolute path is also the Bash permission scope (`Bash(~/.dev3.0/bin/dev3 *)`).
