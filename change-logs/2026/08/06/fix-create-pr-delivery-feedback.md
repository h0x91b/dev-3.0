Short: Create PR now tells you what happened

The Create PR and PR + auto-merge buttons used to hand the request to the agent in total
silence, so a failed handoff looked exactly like a successful one. They now show the same
three answers the Rebase and Commit handoffs give: the request reached the agent, delivery
could not be confirmed, or no agent terminal was found. None of the messages claims the pull
request itself exists — only that the request reached the agent.
