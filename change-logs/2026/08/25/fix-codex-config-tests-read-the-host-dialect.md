Short: Windows proof green again

The Codex hook-block tests hardcoded the POSIX spelling of the dev3 CLI, so they
failed on the windows-latest proof job where the generated command is a quoted
`dev3.exe` path with no shell guard. `ensureCodexConfig` now takes the hook
dialect as an option, and the tests pin both dialects explicitly so each runner
covers the other platform's output too.
