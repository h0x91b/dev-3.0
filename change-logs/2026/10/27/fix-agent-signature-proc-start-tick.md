Short: Held messages survive clock adjustments

On Linux, held `dev3 message` deliveries, `--agent` handles and replies are no longer dropped as "no longer running" when the system clock is adjusted (common on WSL), because the agent process is now pinned by its `/proc` start tick instead of `ps lstart`.
