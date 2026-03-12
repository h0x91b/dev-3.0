Added a "Spawn Agent" button in the task info panel that opens a modal to select an agent and configuration, then spawns it in a new vertical tmux pane within the same task session. This makes multi-agent workflows discoverable without needing to know tmux commands. Also extracted the Select component from LaunchVariantsModal into a reusable shared component.

Suggested by @bfrfrr (h0x91b/dev-3.0#250)
