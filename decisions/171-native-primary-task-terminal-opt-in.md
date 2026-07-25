# 171 — Running a task's primary terminal on the native backend, by explicit opt-in

## Context

The tmux-removal roadmap (seq 1141) had merged a native terminal host, a persisted
`terminalBackend` identity codec (decision 164/165), and a backend-neutral product
seam (decision 169) — none of which any product code was allowed to call. This task
(seq 1292) is the first real product caller: one dev3 task's PRIMARY terminal runs
on the native backend when, and only when, its record carries an explicit
`terminalBackend: "native"`. tmux stays the default for every other task, and there
is no UI toggle.

## Investigation

Three things did not fit the merged pieces as-is.

**The seam only carried a command STRING.** The native backend spawns a process
directly, so a string would have to be split by guesswork; the launch is
`<user shell> <run.sh>` and that path can contain spaces. The seam's own
`native-backend` turned the whole string into an executable with an empty argv,
which cannot run the real wrapper.

**Streaming lives above the seam by design** (`contract.ts` says so), yet the whole
product terminal is a byte stream. The seam exposes point-in-time captures only.

**The packaged host image shipped the wrong host.** `native-terminal-host/main.ts`,
the entrypoint inside the Windows packaged image, is a packaging *tracer*: it
hardcodes a PowerShell spawn and a state-file/stop-file protocol. It has none of the
registry host's record/token/WebSocket/journal machinery, so a packaged build had no
way to start a real product session.

## Decision

- **Contract expansion** — `TerminalSessionSpec`/`TerminalViewSpec` gained an
  optional `launch: { executable, argv }` that wins over `command`
  (`terminal-backend/contract.ts`). tmux quotes it back into one shell string
  (`launchCommand` in `tmux-backend.ts`); native passes it straight into a
  `ShellLaunchSpec`. `openSession` also hands geometry to the native launch instead
  of resizing after the shell already painted once. New typed failure:
  `invalid-launch`.
- **One resolver** — `src/bun/task-terminal-backend.ts` decodes the identity once
  and returns the matching adapter. It is the ONLY production importer of the seam
  (narrowed `terminal-backend/__tests__/isolation.test.ts` asserts exactly that), so
  backend branches cannot spread. An undecodable value throws; nothing falls back.
- **Bytes stay above the seam** — `src/bun/native-task-terminal.ts` holds one
  long-lived `NativeSessionClient` per session, which is the exact role the single
  attached tmux client plays. `pty-server.ts` keeps its batching, OSC 52, bell, and
  smallest-client geometry negotiation backend-agnostic behind one `sessionShell()`
  accessor.
- **Merged, not replaced, packaged entrypoint** — `native-terminal-host/main.ts`
  gained a `session-host <sessionId>` verb that runs the registry host. The
  packaging tracer's `version|start|reattach|stop|__host` verbs are untouched, so the
  existing Windows packaged-runtime proof keeps passing while product sessions get a
  real host.
- **Host runtime resolution** — `src/bun/native-host-runtime.ts` resolves, in order:
  `DEV3_NATIVE_HOST_ENTRYPOINT` (the documented development path), the packaged image
  discovered beside the app runtime and staged additively into
  `~/.dev3.0/native-host-images/<tag>/`, then the registry CLI in a source checkout.
  No runtime means a `NativeHostRuntimeError` naming the missing install step — never
  a silent tmux start.
- **Routing by identity, not by memory** — teardown (`destroyTaskPty`), boot
  reattach (`rehydrate.ts`), and `getPtyUrl` branch on the task's persisted identity.
  `killDevServer` is skipped for a native task because a dev server IS a tmux session
  and probing tmux for a native task is exactly what must not happen.
- **`bootObserved.tmuxAlive` renamed to `terminalAlive`** — the flag now means "live
  on this task's own backend"; keeping the tmux name would have been a lie in the
  lifecycle machine.
- **Operator surface** — `dev3 task terminal-backend [--to tmux|native]`, CLI-only.
  It is the one place that asks BOTH backends about one task, because the switch gate
  needs that answer; it refuses to switch while either side still owns a live
  session, since live terminal state is never migrated.

## Risks

- `destroySessionAwaited` exists because a native session id is deterministic: a
  relaunch racing its own teardown would hit `session-exists`. Restart/resume/recovery
  paths await it; the tmux path keeps its exact fire-and-forget `kill-session` timing.
- Every renderer attached to one task multiplexes through the app's single writer
  client, same as tmux. Writer ownership is only enforced against OTHER processes
  attaching to the host — which is what the host's lease is for.
- A packaged macOS/Linux build ships no host image, so a native task there fails with
  the diagnostic rather than running. Packaged Windows is the supported target for
  this slice.
- Multi-view remains typed `unsupported`: split panes, extra agent panes, the
  virtual-project side shell, and dev servers are absent for a native task by
  construction, not by accident.

## Alternatives considered

- **Branch inside `createSession`/`launchTaskPty` instead of a separate native
  path.** Rejected: "tmux was not involved" then becomes a claim about control flow
  buried in one function rather than something a reader can check at the call sites.
- **Push streaming into the seam.** Rejected: it would drag the wire protocol,
  backpressure, and journal replay into a contract whose whole value is that both
  backends can satisfy it.
- **Replace the packaged tracer entrypoint with the registry CLI.** Rejected: it
  would rewrite the green Windows packaging proof in the same change that first
  ships a product path — two risky things at once.
- **Reconstruct the reconnect screen in the app** (journal tail read + dedup against
  the live stream). Rejected once we found the host already replays its bounded
  journal to a newly attached client, which is exact where any app-side stitching
  would guess.
