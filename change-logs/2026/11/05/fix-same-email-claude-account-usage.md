Short: Usage no longer leaks between Claude accounts

Claude usage is now attributed to the account whose login the session really runs on. Before, an agent spawned on a different account inside a running task (and its agent-team teammates) could report its quota under the task's first account, so two accounts showed identical numbers. Accounts with the same email in different organizations are also told apart by organization id, not by organization name.
