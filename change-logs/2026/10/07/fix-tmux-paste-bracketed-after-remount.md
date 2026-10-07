Short: Multiline tmux paste stays bracketed

A multiline paste into a tmux-backed terminal now arrives as one bracketed paste after a task switch, a terminal remount or Hard Reset Terminal, instead of being split by Claude Code or run line by line by a shell. tmux turns bracketed paste on in its client terminal only once per attach, so a fresh dev3 terminal never learned it; apps that did not ask for bracketed paste still receive plain text, because tmux strips the markers for them.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#1924)
