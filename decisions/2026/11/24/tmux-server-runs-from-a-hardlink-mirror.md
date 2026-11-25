# The launchd tmux server runs from a hardlink mirror of the bundle

## Context

`decisions/2026/11/12/same-path-update-keeps-tmux-tcc-access.md` relied on tccd falling back to the
responsible *path* once an update deleted the server's tmux, and stopped reporting that case. On macOS
27.0.1 and 27.2.1 (two Macs, in-app update to 1.65.1, 2026-11-24) it did not hold: both launchd
servers kept running the deleted inode (`lsof -Fikn` → `k0`), `tmux run-shell 'ls ~/Documents'` from
them returned `Operation not permitted`, and panes saw `git` fail on `commondir` for repos under
`~/Documents`, on and off for hours (sandboxd caches verdicts). The app said nothing.

## Investigation

Isolated launchd servers on a third macOS 27.2.1 Mac, each on its own socket, probed with `run-shell 'ls ~/Documents'`:
a server from a hardlink tree of the bundle kept access after the source bundle was deleted, and
`proc_pidpath` kept the mirror path. `lsof` is not a reliable name: it shows whichever link was looked up
last (exec of the bundle path by any client), and a bare `/tmux` (`k1`) once that link is gone. A fresh server started from the mirror after the source was gone
got access on its first check. A bare tmux outside any `.app`, and a server whose bundle was deleted
with nothing put back, both hung on the check instead of answering. A same-path swap with a
byte-identical copy got access, so the fallback is not simply gone. The live server on that Mac was
also `k0` after its 1.65.2 update, with access still cached. `codesign --verify --deep --strict` passes
on the mirror (`dev3.electrobun.dev`), and hardlinking out of `/Applications/dev-3.0.app` needs no extra permission.

## Decision

`ensureLaunchdServer` (`src/bun/tmux/launchd-server.ts`) hardlinks the whole bundle to
`<data root>/tmux-host/<tmux inode>/<App>.app` (`mirrorBundle`), writes a `complete` marker last (readdir
order links tmux long before `Info.plist`, so an interrupted build is never reused), and starts the job from that tmux.
An update deletes the bundle, not the server's file, so tccd never has to fall back. When the mirror
cannot be built (another volume, a read-only root), the server runs from the bundle as before.
Thirty seconds after a successful start, off the start path, `pruneMirrors` deletes mirrors older than
10 minutes whose name is no running tmux's executable inode (one `lsof -c tmux -a -d txt -Fi` scan,
~0.15 s; a per-path `lsof -t` took ~3 s and timed out on busy Macs), so an old bundle costs disk only
while its server lives. `staleServerBinary`
again reports `deleted` for an executable with no links (or, without a link count, a replaced inode or a
missing path; `src/shared/tmux-server-executable.ts`), so servers started before this change get the
"Restart terminals" notice once. A mirror is recognised by its inode-named directory, not by lsof's path. `dev3 doctor` gained a `tmux server` line (`src/cli/commands/doctor-tmux-server.ts`), only in panes
of a bundled tmux: the hosting server's pid, whether its file is still on disk or is the mirror, and a listing of the first
project under a privacy folder from the terminal's own process.

## Risks

- tccd crediting a mirror outside `/Applications` to the app's grants is observed, not documented.
- A mirror holds the old bundle's blocks (~350 MB) until its server exits; long-lived servers keep it.
- Pruning deletes under the data root. It touches only `tmux-host/`, which this code creates, and
  only numeric entries there, never one a running tmux executes, one younger than 10 minutes (another
  instance may be about to start from it), or anything at all when the scan fails.
- The one-time notice after the first update still asks to restart terminals on Macs where the path
  fallback would have held.

## Alternatives considered

- **Probe-gated notice only** (`run-shell` against a protected folder): sandboxd keeps the old verdict
  for hours, so a probe at launch right after the update reads "allowed" and the loss arrives later, unannounced.
- **APFS clone (`cp -c`) instead of hardlinks**: equivalent for a server started from it, but it means
  spawning `cp`, while `linkSync` keeps the very inode with no extra disk until the bundle is deleted.
- **Hardlink only the tmux binary**: lsof then reports a bare path outside any `.app` (see the 11/12 record).
