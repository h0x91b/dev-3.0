Fixed a terminal selection that stayed glued to the screen while a full-screen TUI (Claude Code, vim, htop) repainted underneath it. ghostty-web never clears the selection on write, so on the alternate screen the highlight floated over the wrong text; we now drop any alt-screen selection on each write. Primary-screen scrollback selections are unaffected.

Suggested by @shaharitzko (https://github.com/shaharitzko)
