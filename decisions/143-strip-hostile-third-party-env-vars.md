# 143 — Strip hostile third-party env vars (CLAUDE_CODE_DISABLE_MOUSE_CLICKS)

## Context

Some users export `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` in their login shell for their own use of the Claude Code CLI. Inside dev3's managed tmux panes (`mouse on`, drag-to-copy bound in `src/bun/tmux/config.ts`) this var changes Claude Code's mouse handling so that click/drag text selection — i.e. copying — stops working. The variable has nothing to do with dev3; it just breaks us.

## Investigation

dev3 inherits the user's full login-shell environment via `resolveShellEnv()` → `applyFullShellEnvToProcess()` (`src/bun/shell-env.ts`), which injects `fullEnv` into `process.env`. Every spawned process then gets it, because `src/bun/spawn.ts` merges `{ ...process.env, ...opts.env }`, and the tmux/pty session (`src/bun/pty-server.ts`) spreads `process.env` too. So the var rode from `.zshrc` → dev3 `process.env` → tmux → Claude.

## Decision

Introduce `NEUTRALIZED_ENV_VARS` (a set) and `stripNeutralizedEnvVars(env)` in `src/bun/shell-env.ts`. `isDeniedEnvVar()` now also excludes these from `fullEnv` (login-shell path), and `applyFullShellEnvToProcess()` calls `stripNeutralizedEnvVars(process.env)` unconditionally at startup (covers the case where dev3 was launched from a terminal that already had the var, e.g. `bun run dev`, plus the `importShellEnv=false` / unresolved-shell paths). Both GUI (`index.ts`) and headless (`headless-entry.ts`) entrypoints already call `applyFullShellEnvToProcess`, so one chokepoint covers every spawn path (tmux, agents, scripts, git).

## Risks

- A tmux server started by an *older* dev3 build (before this fix) keeps the polluted var in its global environment; panes it spawns still inherit it. This is a one-time upgrade transient — resolved as soon as a fixed dev3 starts the tmux server. Not worth a `set-environment -gru` scrub.
- The strip is global (all children), which is intended: no dev3 code path wants Claude's mouse clicks disabled.

## Alternatives considered

- Strip only in `pty-server.ts` at tmux spawn: misses agents/scripts and requires editing both `envFlags` and `processEnv`; fragile.
- Add to `SHELL_ENV_DENYLIST` only: keeps `fullEnv` clean but does not remove the var from `process.env` when dev3 is launched from a terminal that already exports it.
