Short: Edited agent command now takes effect

Fixed editing an agent's base command having no effect on new sessions: the auto-cached resolved binary path kept pointing at the previous binary and silently overrode the edited command at every launch. A cached path now only applies while it still names the same binary as the agent's current base command, while a path you set yourself under Settings → Agents → Custom path is kept separately and always wins.
