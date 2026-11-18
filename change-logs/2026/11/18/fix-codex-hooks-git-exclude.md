dev3 now adds `/.codex/hooks.json` to the repo's `info/exclude`, so the Codex hooks file it writes into a task worktree no longer shows up in `git status`. `dev3 install-hooks` now also excludes `.claude/settings.local.json` the same way.

Contributed by @diverru (h0x91b/dev-3.0#2322)
