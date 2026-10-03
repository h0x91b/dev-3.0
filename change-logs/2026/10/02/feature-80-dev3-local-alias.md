Short: dev3 local for loopback-only remote

`dev3 local` is a shorthand for `dev3 remote --no-tunnel --host 127.0.0.1`: the headless server listens on this machine only and opens no public tunnel. It takes every `dev3 remote` subcommand, including `install-service`, and flags you pass after it win over the defaults it adds.
