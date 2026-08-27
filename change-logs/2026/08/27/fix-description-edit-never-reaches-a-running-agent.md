Short: Warn when a description edit misses the agent

A task's description is delivered as its agent's first prompt at launch and nothing re-delivers it, so rewriting a running task's brief changed the board while its agent never found out. `dev3 task update --description` on a task with a live agent now prints a note saying so and suggests the `dev3 message` command to send alongside it; the same warning is spelled out in `dev3 task update --help` and in the dev3 skill every agent loads at startup.
