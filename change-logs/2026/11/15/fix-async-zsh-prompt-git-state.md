Pressing Enter in a dev3 zsh terminal no longer waits on `git status`: the prompt's git state is now fetched in the background and the prompt redraws when it lands, so large repos with a stale index stop adding seconds to every prompt.

Suggested by @yakirn (h0x91b/dev-3.0#2288)
