Short: Dev server starts on Windows

The Dev Server button and `dev3 dev-server start` no longer refuse on Windows with "the dev-server pane requires the tmux backend, which is POSIX-only": that refusal belonged to the nested tmux session the tmux backend hosts the server in, not to the pane, and a Windows task is always native. The pane's wrapper script is now written in the platform launch dialect (PowerShell there, byte-compatible bash on macOS and Linux) and launched through it instead of a hardcoded `/bin/bash`, and the marker that re-finds the pane no longer assumes a `.sh` file name. A project's own `devScript` is still the user's text in the user's shell — dev3 does not translate it, so a POSIX dev command still needs a Windows-compatible form.

Fixes h0x91b/dev-3.0#1387
