Short: Agent protocol fits shared-folder tasks

A task that runs in the shared folder of a project with the git workflow off now launches its agent with a protocol written for that folder: no branch rename, no "this worktree is your isolation", and pull requests become optional helpers instead of the required route. It tells the agent that other tasks edit the same tree, to stage by explicit path, and never to stash, reset, clean or move the shared branch; agents that inject no protocol at launch get those rules in their task prompt. Tasks with a worktree, including a gitless task created with `--worktree`, keep today's text, and `dev3 current` shows the variant on a new `Protocol:` line.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2242)
