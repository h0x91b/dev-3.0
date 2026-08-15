Short: Stop bloating Claude Code's config

dev3 no longer leaves dead trust entries behind in Claude Code's `~/.claude.json`. Every task launch used to add a `projects` entry for its worktree and nothing ever removed it — on one machine that was 2 130 entries for deleted worktrees, half of a 1.9 MB file. dev3 now prunes them when a worktree is torn down and sweeps the leftovers once per app launch; entries that are not dev3 worktrees, and files it cannot parse, are never touched.
