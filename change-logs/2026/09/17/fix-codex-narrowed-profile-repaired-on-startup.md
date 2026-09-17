Short: Repair a narrowed Codex config

An older dev3 wrote a permission profile into `~/.codex/config.toml` narrower than Codex's own default, which stops standalone Codex from starting a session on a Homebrew install with `sandbox-exec: execvp() ... Operation not permitted`. dev3 now widens that one grant back on the next launch, in the same pass that patches the rest of the file. The fingerprint is exact — `default_permissions = "workspace"` with `":minimal" = "read"` as the profile's only filesystem grant, which is what dev3 itself wrote — so a profile carrying anything else is left alone.
