Fixed tasks getting stuck in-progress with a misleading "[session ended]" terminal when worktree preparation fails (empty repo or missing base branch). The task is now reverted to To Do and the real error is shown as a toast. Empty repositories also get a clearer "no commits yet" message.

Suggested by @sworgkh (h0x91b/dev-3.0#629)
