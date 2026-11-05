Short: Peer-launched Claude no longer exits at trust

A Claude task launched by another agent no longer quits at Claude Code's "Do you trust this folder?" dialog: dev3 types the launch handoff only after that session reports it has started, and only into its own pane. dev3 now writes worktree trust into `~/.claude.json` under Claude Code's own lock and replaces the file atomically, so a concurrent Claude save is much less likely to erase it. An agent that exits before its session starts (trust declined, a crash at boot) moves the card to Has Questions with a badge instead of leaving it on "Agent is Working".

Suggested by @shamrai-nikita (h0x91b/dev-3.0#2034)
