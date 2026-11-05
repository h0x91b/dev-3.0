Short: Merge offer waits for a subscribed agent

When an agent watches its PR with `dev3 pr watch`, dev3 no longer asks "complete the task?" the moment the PR merges: it lets the agent handle the merged message first and makes the offer once the agent's turn ends, or after 10 minutes if the agent never gets the message. The merged message also stops promising an offer when the worktree has uncommitted changes or commits the PR does not include.

Contributed by @diverru (h0x91b/dev-3.0#2085)
