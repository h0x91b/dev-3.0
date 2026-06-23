Fixed the dev3 CLI intermittently reporting "app not running" while the desktop app was alive. The CLI now retries transient Unix-socket failures — both connect (ECONNREFUSED/ENOENT/EAGAIN) and socket discovery — with short backoff before giving up, instead of declaring the app offline on the first hiccup (common when agent hooks fire many CLI calls in bursts, especially on macOS). Running any command with DEV3_DEBUG=1 now prints why resolution failed (HOME, sockets dir, each socket's pid/liveness, failing stage, last errno).

Suggested by @banuni (h0x91b/dev-3.0#714)
