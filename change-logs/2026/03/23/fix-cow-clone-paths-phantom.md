Fixed Clone Paths (CoW) not being copied into worktrees. The `sanitizeConfigPaths` function was creating phantom `clonePaths: []` entries in config files even when clone paths were never configured, which shadowed project-level values via the `??` cascade. Also hardened `resolveProjectConfig` to treat empty arrays from file-based configs as "not configured" so they fall through to lower-priority layers.

Suggested by @genrym (h0x91b/dev-3.0#378)
