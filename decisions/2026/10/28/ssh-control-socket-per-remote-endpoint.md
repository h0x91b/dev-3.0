# Key the fetch SSH control socket by the remote's endpoint, not by `%C`

## Context
`ssh-controlmaster-for-background-fetch` (PR #2012) ran every fetch with `ControlPath="<DEV3_HOME>/ssh/%C"`. `%C` hashes the *resolved* HostName, port, user and local host — not the `~/.ssh/config` alias. On a machine with two GitHub accounts (`git@github.com-work:…` with one IdentityFile, `git@github.com-personal:…` with another, both `HostName github.com`) every repo shared one master, and so one identity: whichever account connected first. Background fetches kept that master alive, so work repos got "Repository not found" in ~0.4 s forever, PR review tasks could not fetch their branch, and new worktrees started from a stale base.

## Investigation
Reproduced with `git ls-remote` against the work repo: the app's `GIT_SSH_COMMAND` fails in 0.35-0.43 s and the master on that socket answers `ssh -T` as the personal account; plain ssh succeeds in ~3 s. A fresh ControlPath dir with the work alias produced the very same socket name, so `%C` provably ignores the alias. ssh does not fall back on an over-long ControlPath (exit 255, measured on OpenSSH 10.3), which rules out putting the raw alias (`%n`) in the path.

## Decision
- `fetchSshEnv` in `src/bun/git.ts` reads the remote's effective URL (`git ls-remote --get-url <remote>`, insteadOf applied) and `sshEndpointOf` reduces it to `user@alias:port` as the URL spells it. `fetchSshCommand` names the socket after the first 16 hex chars of its sha256, so the path has a fixed length and the existing sun_path budget check stays exact. Repos on the same alias still share one master.
- Sockets live in a new sibling dir `<DEV3_HOME>/ssh-mux`. The old `ssh/` dir is never read, renamed or deleted (other installed versions use it); a poisoned `%C` socket there cannot affect this version, and it dies 300 s after its last user stops.
- A repo with `core.sshCommand`, or an environment with `GIT_SSH_COMMAND`/`GIT_SSH`, keeps its own command: our env var would otherwise override it and with it the identity that repo chose.
- The branch picker's refresh (`fetchBranches`) is an explicit action and now passes `force`, so failure backoff can no longer turn it into a silent no-op.

## Risks
- Two extra cheap git reads per fetch (~10 ms total).
- An `~/.ssh/config` edit that remaps an alias is seen only after the master expires (up to 300 s).
- A repo with `core.sshCommand` loses connection reuse (and our BatchMode), exactly as before PR #2012.

## Alternatives considered
- `%n`/`%r@%n:%p` in ControlPath: unbounded length, and ssh refuses instead of connecting when it overflows.
- Hashing `ssh -G <alias>` output (identity-level sharing): one more process per fetch plus ssh config parsing, for no gain over the alias key.
- Skipping multiplexing when alias and HostName differ: loses the speed-up for exactly the multi-account users, and also needs `ssh -G`.
- A per-remote-URL hash: correct, but gives every repo its own master instead of sharing one per alias.
