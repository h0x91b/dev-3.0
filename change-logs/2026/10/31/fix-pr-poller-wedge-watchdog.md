Short: PR status polling no longer stalls silently

The background PR status poller can no longer freeze for hours behind one stuck task: each task's poll is capped at 60 seconds, ticks never overlap, a watchdog replaces a tick stuck for five minutes, and `dev3 pr watch` notices are delivered outside the poll so a slow pane cannot hold it up. A periodic heartbeat and info-level log lines for each watch evaluation and delivery make a future stall visible in the log.
