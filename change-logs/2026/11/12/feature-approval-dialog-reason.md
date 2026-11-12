Short: Agents explain approval requests

Agents can now say why they ask: `--reason "<text>"` on `dev3 task move` (complete, cancel, reset, start another task), `task create --scratch --run`, `task hibernate`, `task wake`, `agent spawn` and `agent resume` shows that text in the approval dialog as plain text, attributed to the asking task, and `dev3 approvals list` prints it too.
