Short: Resume a task's session from the CLI

New `dev3 agent resume [--task <id>] [--json]` brings a task's saved agent session back after its terminal is gone (a machine restart, say) through the same path as the Resume Session button: same worktree and branch, every saved pane under its own agent, preset and account, with the resumed conversation ids reported per pane; it never starts a fresh session (an agent CLI that cannot resume is refused, not restarted from the description), exits 31 when the terminal is already running and 32 when there is nothing safe to resume, and asks the user first when another task's agent requests it. `dev3 agent spawn` now refuses a task whose terminal is gone up front, pointing at `agent resume`, instead of asking for approval and then failing, and a recovery screen left open in the app notices a resume made elsewhere instead of offering Resume again.

Suggested by @vit-pavlenko (h0x91b/dev-3.0#1887)
