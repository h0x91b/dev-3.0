# Headless self-update: hand the tunnel over, and let the supervisor relaunch

## Context

A `dev3 remote` box never gets updated. The operator runs the headless server on a long-lived
machine and reaches it from a phone, so nobody ever goes back to a terminal to type
`brew upgrade`; months of releases pile up, including fixes they reported themselves.

The desktop app has none of this problem, and its mechanism cannot be reused: Electrobun's
bundle-swap `Updater` is not compiled into the CLI binary at all (`checkForUpdate`,
`downloadUpdate`, `applyUpdate` all throw "not available in headless mode"), and the GUI in
turn cannot run brew. Only the update *check* already worked headless — it just fetches
`update.json`.

Restarting is what makes this hard rather than mechanical. The Cloudflare quick tunnel's
`*.trycloudflare.com` hostname is random per `cloudflared` process, the port is random unless
`--port` was passed, and the session cookie is host-bound. A naive stop-then-start hands the
user a dead link and a re-auth on the very device they are holding.

## Investigation

Five facts shaped the design, and four of them contradict the obvious approach:

1. **Homebrew Cask does not keep the app under `Caskroom`.** The `app` stanza *moves*
   `dev-3.0.app` into `/Applications`, so a cask install and a DMG install have identical
   paths. The only thing that distinguishes them is the version brew recorded — which is also
   why most cask installs have *drifted* (the GUI updater bumps the bundle itself; the cask
   sets `auto_updates true` for exactly this reason).
2. **The two channels publish CLI tarballs under different directory names.** A stable release
   syncs artifacts to the tag (`dev-3.0/v1.45.2/`); canary has no tag and syncs to the full
   commit sha (`dev-3.0/<sha>/`). The manifest's `sha` field is the only thing that can locate
   a canary tarball, so it had to be threaded out of the update check.
3. **systemd kills the whole cgroup when a unit stops.** With the default
   `KillMode=control-group`, a relaunch helper we spawn from a unit dies at exactly the moment
   it is needed — and `KillMode=process` is documented as "not recommended".
4. **`which dev3` is almost never the install.** The GUI copies the CLI to
   `<dev3Home>/bin/dev3` as a real 76 MB file (tmp + atomic rename, `src/bun/index.ts`) on
   *every* launch, and puts that directory on PATH. `realpathSync` resolves it to itself, so it
   looks exactly like a tarball install — while extracting a release into it would violate the
   frozen `~/.dev3.0/` layout, leave the actual install on the old version, and be silently
   reverted by the next app start. It is therefore its own install method, `path-copy`, and a
   refusal.
5. **A brew *formula* upgrade abandons the path the server is running from.** The formula does
   `bin.install_symlink libexec/"dev3"`, so `installDir()` is the version-pinned keg
   (`…/Cellar/dev3/1.45.2/libexec`) and `brew upgrade` puts the new build in a *new* keg,
   moving only `<prefix>/bin/dev3`. Restarting the keg path either finds nothing (brew pruned
   it) or comes back on the OLD build, reports in as a success, and re-offers the same update
   every 30 minutes forever. Casks and tarballs are replaced in place and need no substitution.

## Decision

**One pure planner owns every contentious rule** (`src/shared/self-update.ts`): install-method
detection from the resolved `execPath`, the plan (`brew` / `tarball` / `refused`), the tarball
URL per channel, and the quiet-window reducer. The I/O half (`src/bun/self-update.ts`) only
executes what a plan asks for. The whole matrix is a table test in
`src/bun/__tests__/self-update.test.ts` rather than a set of machines someone has to own.

**The restart is a handoff, not a stop-then-start.** The dying server releases its
`cloudflared` *without killing it* (`releaseMainTunnelForHandoff`), records pid + URL +
`/ready` endpoint + port in `~/.dev3.0/remote/state.json`, and exits. The successor re-binds
that port and calls `adoptMainTunnel`, so the public URL and the session cookie both survive
and the browser's own reconnect backoff restores the page. An adopted entry has no exit
promise, so liveness comes from the `/ready` endpoint the health monitor already polls; the
adopted pid is signalled by `stopEntry` so a restart cannot orphan it. If the port turns out
to be taken, the handoff is discarded and the inherited process killed — the URL is lost, the
box is not.

**Two restart strategies, chosen from the environment** (`chooseRestartStrategy`), instead of
one helper everywhere:

- `supervisor-exit` — under a systemd unit (`INVOCATION_ID`), a container, or a watched
  foreground run: apply, then exit `75` so `Restart=on-failure` relaunches. This deliberately
  **does not** fight the cgroup, keeps `dev3 remote stop` authoritative (a clean stop still
  exits 0), and accepts that `cloudflared` dies with the unit — so **under systemd the public
  URL changes**. Named in `docs/remote-access.md` rather than papered over.
- `helper` — the unsupervised background server (`DEV3_REMOTE_LOG_FILE`): spawn a detached
  `dev3 update --supervise` **from the old binary**, because it is the thing that must still
  work when the new one does not. It waits for our pid, starts the new build, and rolls back
  if the new build never writes its lifecycle state within 60 s.

**Readiness is the state file, not an HTTP probe.** A server writes
`~/.dev3.0/remote/state.json` only after its remote-access server is bound, so `state.pid ===
child` is a real readiness signal, needs no new endpoint, and is the same check the existing
`--detach` launcher uses.

**A tarball apply moves what it replaces into `.dev3-prev/`** inside the install dir — same
filesystem, so every step is a rename, and the rollback has a matching binary *and* `dist/`.
Brew cannot do that (brew owns the Cellar and may prune the old keg), so it copies the binary
aside to `~/.dev3.0/remote/rollback/dev3` and, if it ever has to use it, logs loudly that the
*installed* `dev3` is broken and needs a human.

**Every child process runs asynchronously, and that is load-bearing, not hygiene.** `brew
update`, `brew fetch`, `brew upgrade` and the `tar -xzf` of a ~76 MB binary take seconds to
minutes; `spawnSync` would freeze the server's single event loop for all of it — no HTTP, no
websocket, no CLI socket, no tmux forwarding — killing the very browser session the handoff
exists to preserve. `dev3 update` also sets `DEV3_HEADLESS=1` before its first `bun/` import,
because the plan reaches `./updater` → the Electrobun shim, whose FFI init starts an HTTP
server and can `process.exit()` in a plain CLI process.

**A failing update backs off and eventually gives up** (`retryBackoffMs`, `MAX_UPDATE_ATTEMPTS`,
checked *before* the ceiling in `evaluateQuietWindow`). Past the 72-hour ceiling the quiet
conditions no longer apply, so without this a permanently broken update — a 404 artifact, a
full disk, brew behind a proxy — would re-attempt on every 30-minute tick, 48 times a day, on
a box nobody is watching. Only a NEW version clears the give-up.

**Two "unknowns" deliberately fail closed.** An unreadable terminal-activity probe counts as
busy, never as quiet; and the renderer's 5-minute auto-restart requires a *known*
non-headless context (`headless === false`, not `!== true`), so a failed or still-pending RPC
cannot let a phone tab restart a remote server unattended.

## Risks

- **No tarball checksum.** The manifest carries no artifact hash and the user chose HTTPS-only
  (no `Content-Length` check, no `--version` smoke test on the extracted binary). A truncated
  download therefore becomes a broken binary installed over a working one, unattended. Two
  things blunt it: a truncated `tar.gz` normally fails extraction (and a failed extract aborts
  before anything is swapped), and the supervisor rolls back a build that will not start. A
  corrupt-but-extractable-and-startable binary is not covered.
- **The cask path with real version drift is not covered by tests**, only by the planner's
  refusal. Verifying the accepting branch needs a macOS box whose Caskroom version matches a
  running server — a manual check, reported as manual or not at all.
- **Under systemd the tunnel URL changes**, as above. Putting `cloudflared` into a transient
  `systemd-run --user --scope` would fix it, but it needs a user D-Bus session (absent on plain
  SSH without lingering) and could not be verified from here.
- **A restart landing during worktree creation** leaves a task mid-`preparing`. Accepted: the
  existing stale-worktree recovery picks it up at boot, and "no task in progress" is the one
  condition the 72-hour ceiling never overrides.
- **The staging memo is in-process only.** Pressing Download and then Restart on the same
  server reuses the fetched tree, but a `dev3 update` typed in a shell afterwards does not see
  it and fetches again. Persisting it would mean trusting a tree on disk that nothing
  checksums — worse than a repeated download.
- **No "updating…" state anywhere in the renderer.** A silent restart is visually identical to
  the box falling over; the `lastUpdate` record in the state file, surfaced by
  `dev3 remote status`, is the only explanation and it is read after the fact.

## Alternatives considered

- **Reuse the Electrobun updater headless.** Impossible — it is not in the CLI binary, and it
  swaps bundles, which is the wrong artifact for a formula or tarball install.
- **`systemctl --user restart dev3-remote.service` from a helper.** Needs the helper to survive
  the cgroup teardown, which is the problem it was meant to solve. Exiting non-zero and letting
  `Restart=on-failure` do it needs no helper at all.
- **A named Cloudflare tunnel** for a stable hostname. Solves the URL problem outright, but it
  is an account-bound resource and a much larger feature; out of scope.
- **Letting `dev3 update` do the swap while a server is running.** It would leave that server
  executing an install that is no longer on disk, and the next restart would change the public
  URL — so the CLI delegates over the socket instead.
- **Gating the update on running agents.** Rejected: detached tmux sessions survive a restart
  and lifecycles rehydrate at boot, so a gate would refuse a safe action. The popover warns
  with a count and lets the user proceed.
