Short: Aim the CLI at one dev3 instance

The dev3 CLI can now be pointed at a specific running instance instead of whichever one discovery prefers: `--instance self | primary | task:<id> | seq:<N>` on any command, or `DEV3_CLI_SOCKET=<endpoint>` for a whole shell, and Settings → Install dev3 CLI additionally arms `~/.dev3.0/bin/dev3-self`, which always talks to the instance that installed it. Agent hooks keep invoking plain `dev3` and keep reaching the same instance they always did.
