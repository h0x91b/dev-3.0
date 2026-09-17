Short: Codex outside dev3 keeps full read

The fallback `workspace` permission profile dev3 writes into `~/.codex/config.toml` now grants `":root" = "read"` instead of `":minimal" = "read"`, matching Codex's own default. The narrower grant made standalone Codex sessions on macOS fail at startup with `fs sandbox helper failed ... sandbox-exec: execvp() of '/opt/homebrew/bin/codex' failed: Operation not permitted` on Homebrew installs, where the binary is a symlink. An existing profile is never rewritten, because dev3 cannot tell its own older output from a hand-written one.
