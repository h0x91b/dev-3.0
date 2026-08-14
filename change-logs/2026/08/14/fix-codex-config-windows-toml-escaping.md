Short: Codex starts again on Windows

Fixed the Codex config.toml dev3 writes on Windows: native paths were interpolated raw into TOML basic strings, so `C:\Users` read as the escape `\U` and codex refused to start anywhere on the machine with a parse error. Paths are now escaped and joined with the platform separator, and dev3 repairs an already-broken config in place on next launch (backing the original up to `config.toml.dev3-backup` and leaving every non-dev3 line untouched).

Follow-up: the paths are now joined in the dialect of the path they extend rather than the host's, so a POSIX fixture stays POSIX on a Windows runner.
