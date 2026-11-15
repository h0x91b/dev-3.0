Short: No-agent mark for exited agents

A task whose agent exited while its terminal lives on as a plain shell now shows the same "No agent" mark as a task whose terminal is gone, and stays out of the default Active Tasks list like it. A background probe checks the process table once a minute and clears the mark as soon as an agent runs again.

Contributed by @diverru (h0x91b/dev-3.0#2300)
