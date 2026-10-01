Short: Custom statusLine honors CLAUDE_CONFIG_DIR

The dev3 statusLine wrapper now looks up your own statusLine in `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set, so a custom statusLine configured in a pinned config dir shows up again in dev3-launched Claude sessions instead of only the usage segment.
