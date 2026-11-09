Short: Agents with a subcommand in their command launch

An agent whose command carries more than the executable — a subcommand, an `env` wrapper or `VAR=value` assignments, such as `env /path/to/opencode mini` — is no longer reported as "Agent not found: opencode mini". The install check now looks at the executable only, and a command it cannot resolve up front (a variable, a relative path, a shell builtin) is launched rather than blocked.

Suggested by @gonpra (h0x91b/dev-3.0#2218)
