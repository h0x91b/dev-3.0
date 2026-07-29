Short: Custom output styles work per account

Per-agent Claude config dirs now symlink `~/.claude/output-styles`, so a custom `outputStyle` named in the shared `settings.json` actually resolves instead of silently falling back to the default style; existing accounts are backfilled on the next launch. A configured output style that matches no style is now logged as a warning listing the names that do exist — Claude Code registers a style under its frontmatter `name` instead of its filename, so `low-battery.md` declaring `name: Low Battery` is only reachable as "Low Battery".
