Short: Much smaller app log files

Daily app logs shrink by roughly 85%: task updates now log which fields changed instead of the whole PR status payload, and background polls (task-file loads, dev-server status checks, settings reads, git probes whose "no" exits 1) moved to debug. Day files older than three days are packed into `.tgz` archives next to the original, about 11 times smaller, and removed only after the archive is verified.
