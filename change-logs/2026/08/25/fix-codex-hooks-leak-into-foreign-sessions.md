Short: Codex hooks stay out of other sessions

dev3's Codex status hooks are declared in `~/.codex/config.toml`, which Codex loads in every session on the machine, so they were waking up — and spending a couple of hundred milliseconds per tool call — in Codex sessions that had nothing to do with dev3. The declared command now checks for a dev3 task first and spawns nothing at all outside one (POSIX; on Windows the hook runner may be cmd or PowerShell, so the command is unchanged there), and duplicate hook blocks left behind in the config are collected instead of piling up.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1527)
