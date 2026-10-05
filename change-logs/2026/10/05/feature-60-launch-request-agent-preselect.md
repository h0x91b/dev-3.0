Short: Coordinators can suggest a launch agent

`dev3 task move --status in-progress` and `dev3 task create --scratch --run` accept `--agent <id> [--config <id>]` to preselect the agent and preset in the launch approval dialog, the same way `dev3 agent spawn` does; the user still has the final pick, an unattended auto-approval launches the suggestion instead of the global default, and unknown or mismatched ids fail instead of falling back.

Suggested by @shamrai-nikita (h0x91b/dev-3.0#1911)
