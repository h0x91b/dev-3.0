Short: Clones no longer time out

Tripled the renderer RPC request timeout from 2 to 6 minutes so cloning a large repo through the Add Project dialog no longer fails with 'RPC "cloneAndAddProject" timed out'. The timeout is a last-resort backstop — the bridge watchdog still detects a genuinely dead connection in seconds.
