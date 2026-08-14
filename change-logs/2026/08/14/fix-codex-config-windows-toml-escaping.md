Short: Codex starts again on Windows

Fixed the Codex config.toml dev3 writes on Windows: native paths were interpolated raw into TOML basic strings, so `C:\Users` read as the escape `\U` and codex refused to start anywhere on the machine with a parse error. Paths are now escaped and joined with the platform separator, and dev3 repairs an already-broken config in place on next launch (backing the original up to `config.toml.dev3-backup` and leaving every non-dev3 line untouched).

Follow-up: the paths are now joined in the dialect of the path they extend rather than the host's, so a POSIX fixture stays POSIX on a Windows runner.

Second follow-up: launching Codex on Windows also failed with `expected struct HooksToml`, because the hooks dev3 passes as `-c hooks={...}` lost every double quote on the way into the process — PowerShell escapes nothing for a native command line, and Windows argument parsing consumed them. The argument is now escaped for that parser, and a Windows test spawns real PowerShell and reads back a real process's argv to prove it.
