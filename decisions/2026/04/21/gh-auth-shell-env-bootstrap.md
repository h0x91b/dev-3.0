# 041 — Bootstrap gh auth config from the login shell

## Context

Issue #491 reported that dev-3.0 could keep showing the startup banner
`GitHub CLI (gh) is not signed in` even after `gh auth login` succeeded in
an app terminal. The main process already imported `PATH` and `LANG` from the
user's login shell, but `gh` also depends on config-location variables.

## Investigation

`gh` resolves its config directory from `GH_CONFIG_DIR`, then
`$XDG_CONFIG_HOME/gh`, then `$HOME/.config/gh`. A login shell can export one
of the first two, while the GUI app process still runs without them, so the
backend auth check and the terminal shell can read different credential stores.

## Decision

`src/bun/shell-env.ts` now reads `XDG_CONFIG_HOME` and `GH_CONFIG_DIR` from the
login shell alongside `PATH` and `LANG`. `src/bun/index.ts` and
`src/bun/headless-entry.ts` apply those values to `process.env` before any `gh`
checks or spawned subprocesses run.

## Risks

If a user's shell exports a broken `GH_CONFIG_DIR`, dev-3.0 will now inherit
that breakage instead of silently falling back to `$HOME/.config/gh`. That is
acceptable because matching the user's actual shell behavior is less confusing
than inventing a second auth context inside the app.

## Alternatives considered

- Hardcode `~/.config/gh` in dev-3.0. Rejected because it ignores documented
  `gh` environment overrides and preserves the mismatch with shell sessions.
- Re-check auth only from PTY shells. Rejected because the backend also needs
  the same environment for non-interactive `gh` commands and remote mode.
