Short: PR status messages for agents

New `dev3 pr watch [--until ci|merged]` subscribes a task's agent to its pull request and returns at once. dev3's own PR poll then types one short message into the agent when CI finishes on the pushed head, or when the PR is merged or closed, so agents no longer poll `gh` or set timers. Without a subscription nothing is sent.

Contributed by @diverru (h0x91b/dev-3.0#2047)
