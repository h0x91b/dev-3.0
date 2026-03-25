Added a global "Prevent Sleep" setting that keeps your system awake while agents are running. Uses caffeinate on macOS and systemd-inhibit on Linux. Enabled by default when a supported tool is found on PATH. Includes a 1-hour safety timeout — the poll cycle restarts it automatically if agents are still active.

Suggested by @aidanpraidw (h0x91b/dev-3.0#384)
