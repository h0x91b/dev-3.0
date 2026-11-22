Short: Codex requests task completion itself

The agent protocol now tells every agent to open the completion (or cancel) approval dialog itself once the work is preserved, instead of telling the user to close the task by hand — Codex read the old "allowed" wording literally and never asked. Tasks the user completes manually (coordinator, board-cleanup, `--manual-completion on`) stay the user's to close, and `dev3 current` now prints a `Manual completion: on` line so the agent can tell.

Suggested by @nadavsheinbein (h0x91b/dev-3.0#2337)
Contributed by @nadavsheinbein (h0x91b/dev-3.0#2338)
