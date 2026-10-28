# SSH connection reuse and a priority lane for background fetches

> Superseded in part on 2026-10-28 by `decisions/2026/10/28/ssh-control-socket-per-remote-endpoint.md`: the `ssh/%C` socket shared one identity across ssh aliases of github.com; sockets are now keyed by the remote endpoint under `ssh-mux/`. The queue and priority lane below still stand.

## Context
The task git bar waited on `git fetch origin` calls that run FIFO per repo in `fetchProjectQueue`. The visible task queued behind background fetches (merge detection, other branches), and an unpushed task branch failed with "couldn't find remote ref" after ~2 s on every try.

## Investigation
One `git fetch origin main` takes ~2.2 s; the SSH handshake to github.com alone is 1.5-1.7 s. With ControlMaster connection reuse the same fetch takes ~0.75 s. The renderer RPC timeout is 6 minutes, so a lost `getBranchStatus` spun for 6 minutes.

## Decision
- `fetchFromRemote` runs git with `ControlMaster=auto`, `ControlPath="<DEV3_HOME>/ssh/%C"` and `ControlPersist=300` on non-Windows (`fetchSshCommand` in `src/bun/git.ts`). The `ssh` directory is new, mode 0700. ssh does not fall back when the socket path exceeds sun_path (104 bytes on macOS) — it fails the fetch — so a control dir longer than 45 bytes (e.g. the QA-scope `DEV3_HOME` under `$TMPDIR`) gets no connection reuse at all.
- The per-repo queue is a list of pending jobs plus one running job (still one fetch per repo, which prevents `packed-refs.lock` races). `priority` jobs go after the last queued priority job and before normal jobs. `getBranchStatus` and `getTaskDiff` fetches are priority; everything else is normal. A job that waited over 2 s logs `fetchOrigin: queue wait`.
- `fetchOriginBranches` fetches the base and the task branch in one git process; on failure it falls back to one fetch per branch. A task branch with no `refs/remotes/origin/<branch>` was never pushed and is not fetched.
- `useTaskBranchStatus` rejects a status request after 20 s (poll) or 45 s (refresh), which feeds the error label and Retry. The global RPC timeout is unchanged.

## Risks
- ControlPersist keeps an ssh master process alive up to 300 s after the last fetch.
- A user ssh config with its own ControlMaster is overridden only for dev3's fetches.
- Windows is unchanged, and HTTPS remotes are unaffected.
- A stale socket in the `ssh` directory is handled by ssh itself (it falls back to a direct connection).

## Alternatives considered
- Editing the user's global ssh config: touches their setup, rejected.
- A second parallel fetch lane: risks `packed-refs.lock` contention, rejected.
- Lowering the global RPC timeout: would cut legitimately long calls, rejected.
