# 191 — Native pane reattach and cross-instance owner routing

## Context

Several dev3 app processes share one `~/.dev3.0` (decision 022 — dev3 is developed
using dev3, so a dev build runs beside the installed app). A native pane's host is
a separate process; app processes connect to it as WebSocket clients, and
`WriterOwnership` grants the writer lease to the FIRST client — across every app
process. Two independent failures came out of that:

1. A task with live panes showed `[no terminal session — Unknown session]` for
   pane-1 in any viewer that was not the process which launched the task, while
   panes 2..N rendered live output.
2. Seq 1371 found that a non-owning process attaches as an observer, so its input
   is dropped by the host while `message.send` still answers `delivered: true`.

## Investigation

The `sessions` map in `pty-server.ts` is process-memory. The bare-`taskId` entry
that pane-1 attaches through is created only by `createNativeTaskSession` (launch)
or `reattachNativeTaskSession` — and the sole production caller of the latter is
`getPtyUrl`, which `TaskTerminal.tsx` skips entirely for native tasks. Panes 2..N
survived because `getPanePtyUrl` registers them lazily on every call, from any
process. The WS-open reattach fallback could not help: it sits *after* the
`sessions.get()` miss that already closed the socket with `UNKNOWN_SESSION`.

Confirmed by making the three new `getPanePtyUrl` cases fail against `HEAD` before
the fix.

## Decision

**Discovery** — `getPanePtyUrl` (`rpc-handlers/task-panes.ts`) rebinds the first
pane on demand when this process holds no session, exactly as it already did for
the rest. It never spawns; an unrebindable pane answers `{ gone: true }` instead of
a URL the app will refuse.

**Owner routing** — the host is the only process that knows who holds the lease, so
it reports it: `hello` carries `clientPid`, `status` answers `writerPid`
(`native-terminal-registry/protocol.ts`, additive v1 fields — the protocol already
ignores unknown additive fields). `native-pane-owner.ts` turns that into
`local | peer | vacant | unknown | gone` and forwards a whole request to the owning
peer over the NDJSON socket the CLI already speaks. **Absent `writerPid` resolves
to `unknown`, never `vacant`** — reading it as vacant would invite a claim that cuts
off whoever is typing.

**Honest roles** — `effectiveNativeRole` (`pty-server.ts`) requires BOTH leases: our
own picks the viewer, the host's decides whether this process may type at all.
`Take control` asks the host first and reports a refusal as a refused keystroke
rather than moving a lease it does not own. While a bind is in flight the role is
unknown and stays optimistic, then `broadcastNativeRoles` corrects every viewer.

**Vacancy notice** — found by QA'ing a live task from a second instance: that
instance took the free lease, quit, and left the first window read-only against a
host with no writer at all — resize dropped, `Take control` a no-op, and a strip
blaming a viewer that no longer existed. The host cleared the writer on socket
close but told nobody, and `NativeSessionClient` discarded unsolicited ownership
frames as "no pending request". `WriterOwnership.detach` now returns the survivors
and the host notifies them; the client applies the frame and raises `onRoleChange`.
The lease itself still never moves implicitly — decision 158 stands, and the
existing "observers stay unpromoted until one explicitly claims" test with it.
`writerAttached` rides the attach/role frames so the strip can say *the slot is
free* instead of *someone else is typing*.

**Observer geometry** — an observer rendered the writer's byte stream at its own
container width, wrapping every line that reached the right edge (visibly garbled
bottom rows). `pty-server.ts` already promised "observers letterbox"; the client
had no geometry to do it with. The attach and role frames now carry the PTY's
`cols`/`rows`, republished on every writer resize, and `refitToContainer` adopts
them for an observer instead of calling `proposeDimensions`.

## Risks

- A viewer is briefly told `writer` during the bind window and corrected on
  completion. The alternative — defaulting to read-only — flashes the observer
  strip on every launch.
- `writerPid` is absent on hosts staged before this change, so routing degrades to
  `unknown` there. Callers must surface that as unproven delivery, not silently
  write locally.
- Forwarding costs one peer round trip (10s timeout) on the non-owning path.
- An observer whose window is narrower than the writer's PTY now CLIPS the grid
  rather than scaling it: content is correct but cropped. Completing the letterbox
  with a CSS scale is deliberately left out of this change.

## Alternatives considered

- **Explicit lease transfer** (B claims, writes, releases) — smallest change, and
  rejected: it takes the lease from whoever is interactively typing in A.
- **Host-side inject endpoint** that writes without the lease — cheaper, but
  weakens the one-writer invariant of decision 158 and still leaves B's own
  keystrokes silently dropped, so the role plumbing was needed anyway.
- **One owner process per task at the app layer** — cleanest long-term, far beyond
  this task's blast radius (CLI routing, lifecycle, RPC).
- **Register every active native task's binding at boot** — rejected: it binds
  hosts for tasks nobody is viewing, and `lifecycle/rehydrate.ts` deliberately does
  not do this.

tmux is untouched on every path: `TerminalView` still writes the refusal into the
canvas unless a pane owner supplies `onSessionLost`.
