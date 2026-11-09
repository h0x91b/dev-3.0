Short: Resume a task on another Claude account

Waking a hibernated task or resuming a dead session can now switch its Claude panes to another account: pick it on the wake/recovery screen, in the approval dialog when an agent asks to resume, or with `--account <id|system>` on `dev3 task wake --resume` and `dev3 agent resume`. Codex panes keep the account their conversation started on, and an account whose own history cannot see the conversation is refused before anything launches.
