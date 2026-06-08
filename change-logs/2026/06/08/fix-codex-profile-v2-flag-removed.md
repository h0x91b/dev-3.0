Fixed Codex agents failing to launch on newer codex (`error: unexpected argument '--profile-v2'`). The `--profile-v2` flag was removed from codex and folded into `--profile`, so dev-3.0 now feature-detects the correct profile flag from `codex --help` instead of guessing from the version number.

Suggested by @eladharitanwix (h0x91b/dev-3.0#611)
