Short: CPU pill reflects real CPU usage

The header CPU pill and its "high" / "overloaded" levels now follow how busy the cores actually are instead of the load average, which on macOS counts threads waiting on disk and could read 600% on a 30%-busy machine and stay red for minutes after a spike. The load average is still shown in the CPU popover, and the CPU warning levels in Settings are now percentages of busy time (defaults 80% / 95%).
