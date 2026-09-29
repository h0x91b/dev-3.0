# Setup script runs untraced

## Context
`buildSetupStartupWrapper` and `buildSetupRerunScript` ran the project's setupScript as `<shell> -x setup.sh` (PowerShell: `Set-PSDebug -Trace 1`). zsh enables `-x` before it sources `.zshenv`, and bash before `$BASH_ENV`, so every value a startup file exported was echoed, expanded, into the setup pane (h0x91b/dev-3.0#1854). A `set +x` inside the script runs too late.

## Decision
Tracing is removed from the launch API entirely: `LaunchScriptOptions.trace` and both dialects' traced `runScript` branches are gone, and the setup wrappers run the script plainly. Success/failure reporting (the `✓`/`✗` lines and the exit-code file read by `watchSetupFailure`) is unchanged. `src/bun/__tests__/setup-tracing-secrets.test.ts` executes the real wrappers under zsh and bash with a disposable startup file exporting a fake marker.

## Risks
Users lose the per-command echo in the setup pane; the script's own output is still shown. A user who wants it can put `set -x` in their own setupScript, which starts tracing after startup files (their script's own expansions are then their choice).

## Alternatives considered
- `set -x` injected at the top of the script: skips startup files but still prints secrets the script itself expands (`npm login --token $T`).
- Opt-in setting with a warning: a new setting, UI and i18n for a debugging aid nobody asked for; can be added later on the untraced default.
