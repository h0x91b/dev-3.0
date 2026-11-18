Short: Resume no longer strands the terminal

Resuming a task from its recovery screen no longer leaves the terminal on "[no terminal session - Unknown session]" until the page is reloaded. The terminal used to reconnect before the resumed session was registered and then gave up; it now connects once the resume returns.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2346)
