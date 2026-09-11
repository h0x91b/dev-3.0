Short: Agent prompts no longer sit in argv

Claude agents now receive the dev3 lifecycle protocol through a file on every platform instead of a ~27 KB `--append-system-prompt` argument. The protocol used to sit in each agent's command line, so a `pkill -f` on an ordinary word like `agent-browser` matched and terminated every other agent on the machine. Existing sessions keep their old command line until they are restarted.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1734)
