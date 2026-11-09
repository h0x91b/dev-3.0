Short: Terminals reconnect after a server restart

An open browser terminal no longer shows [session ended] after the dev3 server restarts while its tmux session is still alive. The remote proxy now passes the PTY server's close code through, and a terminal that was streaming re-registers its session once and reconnects.

Contributed by @fallenfuzz (h0x91b/dev-3.0#2217)
