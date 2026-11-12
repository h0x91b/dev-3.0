# A same-path update keeps the tmux server's folder access

## Context

`decisions/2026/10/26/tmux-server-as-launchd-job.md` treated a server whose tmux file was replaced at the
same path (inode changed, `k0`) as having lost Documents, Desktop and Full Disk Access, and offered
"Restart terminals". Every update replaces the bundle at the same path, so every update asked the user to
kill every task terminal and running agent, for nothing.

## Investigation

Production, 2026-11-12: a canary update swapped `/Applications/dev-3.0.app` at 13:18. The launchd server
(pid 3576) ran inode 1429635331 `k0`; the path held 1436704340. At 13:22:46, sandboxd asked tccd again for
that server (`kTCCServiceSystemPolicyAllFiles`). tccd logged `Failed to fetch responsible file descriptor:
[2: No such file or directory]`, fell back to the path (`responsible_path=/Applications/dev-3.0.app/…/tmux`),
judged the new, identically signed file there (`subject=dev3.electrobun.dev`) and allowed it (`authValue=2`).
Panes kept `~/Documents`.
`proc_pidpath()` on five isolated launchd servers built from copied bundles shows where the attribution path
comes from. After an Electrobun-style `rm -rf` + rename-in, it returns the original path. After deletion with
nothing put back, it returns `ENOENT`: the record's failure. After a move, it returns the new location. With
only the tmux binary hardlinked elsewhere, it returns that bare path, outside any `.app`. With a hardlink tree
of the whole bundle, it returns the path inside the hardlinked `.app`. Forcing a fresh sandboxd verdict on the
test servers needs root, so the TCC outcome of the hardlink variants is inferred, not observed.

## Decision

`staleServerBinary` (`src/bun/tmux/launchd-server.ts`) reads only the executable path from `lsof`. The path
equals this app's tmux → no notice. Nothing at the path → `deleted` ("will lose access at macOS's next
check": cached verdicts keep working until then). Another present dev3 bundle → `elsewhere`. A server no known
tmux client can drive (`selectTmuxBinary`'s version mismatch) is `incompatible` (`TmuxClient.serverBinaryStale`).
"Restart terminals" (`App.tsx`) is now an honest confirm. It loads `getTmuxRestartImpact`
(`src/bun/tmux-restart-impact.ts`), which counts the task terminals and other sessions and names every agent in
`in-progress`/`review-by-ai` with a live terminal. It holds "Restart now" until that list is shown, and focuses
"Restart later".

## Risks

- tccd's path fallback is observed, not documented. A macOS that drops it would silently bring back the loss on
  update, now with no notice; re-check `ls ~/Documents` in a task terminal after an update on new macOS releases.
- The swap window (Electrobun `rmSync` → `renameSync`, about a second; longer for brew and DMG) and an app that is
  deleted for good still lose access. The planned fix is a hardlink mirror of the bundle that keeps the server's
  inode at a valid bundle path, which also preserves the old tmux client for a protocol change.

## Alternatives considered

- **Copy the bundle before the swap**: new inodes; the server's own inode is still deleted, so `proc_pidpath` fails.
- **Hardlink only the tmux binary**: the attribution path lands outside any `.app`, and tccd judges a bare tmux.
- **Move the bundle aside before Electrobun's swap**: works (the "moved" case), but covers the in-app updater only.
