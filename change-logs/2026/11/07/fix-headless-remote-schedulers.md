Short: Schedules fire on headless dev3 remote

Automations, "Start in" launches, "Send later" messages (`dev3 message --in/--at`), keep-alive revives and per-task focus time now run under headless `dev3 remote`; before, only the desktop app started them, so on a headless box schedules stayed overdue forever and focus time stayed at zero. While a desktop app shares the same data, the headless server leaves the schedules to it so nothing fires twice, and a browser that disconnects while focused no longer keeps earning focus time.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2194)
