Short: Sleep prevention survives a stuck system probe

Sleep prevention now re-checks on its own timer instead of riding the resource-monitor tick, so a tick stuck on a probe can no longer leave the Mac free to sleep until the app restarts. The `ps`, `vm_stat` and `sysctl` probes are stopped after a timeout, a watchdog replaces a tick still running after 60 seconds and logs the stage it stuck in, and opening the tmux sessions popover during a tick no longer starts a second polling loop.
