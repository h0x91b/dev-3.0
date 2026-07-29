Short: Custom output styles work per account

Per-agent Claude config dirs now symlink `~/.claude/output-styles`, so a custom `outputStyle` named in the shared `settings.json` actually resolves instead of silently falling back to the default style. Existing accounts are backfilled on the next launch, and a named-but-unresolvable output style is logged as a warning.
