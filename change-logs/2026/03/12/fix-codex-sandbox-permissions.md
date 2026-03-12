Temporarily disable Codex sandbox via `--sandbox never` flag on all Codex configurations to work around a breaking change in Codex 0.114+ where `[permissions]` requires `default_permissions`. Removed the `[permissions.network]` config.toml patching that was causing startup failures. Fixed default agent config merge logic so that updated defaults (model, args) propagate to existing users who haven't explicitly customized those fields. Model placeholder in settings now shows agent-appropriate examples.

Suggested by @hagamitu-wix (h0x91b/dev-3.0#275)
