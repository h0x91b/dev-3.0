Short: Add task agents from CLI

Coordinators can now use `dev3 agent spawn` to add a managed agent to an existing task, just like +Agent in the UI. Select an agent, preset and account, supply initial instructions or hand over the latest conversation, and receive the new pane ID; agent-initiated launches use the existing approval picker. `dev3 agent list` exposes agent and preset IDs for scripts; account validation follows the effective harness, and pending approvals close when the target run ends without reusing unrelated task-start approvals.
