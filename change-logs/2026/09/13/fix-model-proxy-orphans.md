Short: Keep model routes through restarts

Model proxies are signalled immediately when dev3 quits, including during startup. On supported systems, restarting reclaims a verified orphan only on the address the replacement will use, preserving the session key while leaving other live instances and legacy routes alone.
