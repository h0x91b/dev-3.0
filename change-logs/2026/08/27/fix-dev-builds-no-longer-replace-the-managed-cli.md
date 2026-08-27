Short: Dev builds stop hijacking the dev3 CLI

Running the dev loop (`bun run dev`, or `dev3 dev-server start`) no longer overwrites the machine-wide `~/.dev3.0/bin/dev3` that every agent and terminal runs — a source run used to point it at the `bun` binary (breaking every command with `Script not found`), and a local app build used to copy its own unmerged branch build over it silently. Only an installed build writes that name now; a developer who wants their branch's CLI there can opt in with `DEV3_INSTALL_MANAGED_CLI=1`.
