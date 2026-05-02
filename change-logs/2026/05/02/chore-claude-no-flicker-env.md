Inject `CLAUDE_CODE_NO_FLICKER=1` into all Claude-based agent presets via `CLAUDE_DEFAULT_ENV`, so every Claude launch (Default, Plan, Bypass, Auto, Accept Edits, Don't Ask — Opus and Sonnet variants) inherits the flag automatically.

Also fix the Plan presets: replace `--dangerously-skip-permissions` with `--allow-dangerously-skip-permissions` for `claude-plan` / `claude-plan-sonnet`, since auto-bypassing all permission checks defeats Plan mode's approve-the-plan gate. The `--allow-` variant keeps the flag *available* for the user to flip on demand without enabling it by default.
