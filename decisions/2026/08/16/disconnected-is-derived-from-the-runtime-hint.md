# Disconnected is derived from the runtime hint, not a new task field

## Context

A task whose agent session died with the app (force quit, reboot) kept rendering
as a live session on the board and in the Active Tasks sidebar. The user only
learned the truth by opening it and meeting the "Previous agent session found"
recovery screen, which made "how many sessions are running right now" unanswerable
(issue #1392).

## Investigation

The information already existed. At boot `rehydrateTaskLifecycles`
(`src/bun/lifecycle/rehydrate.ts`) probes tmux / the native host per task and
`bootTransition` (`src/bun/lifecycle/machine.ts`) demotes a `running` task with a
dead terminal to `runtime: "idle"`, persisted in `Task.runtimeState`. Nothing in
`src/mainview/` read that field — the UI derived "active" purely from status +
`worktreePath`.

The one hole: nothing wrote the hint back to `running` when a session came back,
because attaching a terminal was not a lifecycle event at all.

## Decision

- `isTaskDisconnected(task)` in `src/shared/types.ts` — active column, worktree
  present, `runtimeState.runtime === "idle"`, and none of hibernated / draft /
  preparing / shuttingDown. Purely derived; nothing new is written to disk, so an
  older app version reading the same `tasks.json` sees exactly what it saw before.
- `taskSortRank` gains `DISCONNECTED_SORT_OFFSET = 5`, a band between live work
  and the hibernated sink (offset 10).
- New lifecycle event `terminalAttached` (`attachTransition` in `machine.ts`)
  flips a stale `idle` back to `running`. Dispatched from `markTerminalAttached`
  in `src/bun/rpc-handlers/tmux-pty.ts` at the three RPC entry points that put a
  session back up: `getPtyUrl`'s restore branches, `resumeTask`, `restartTask`.
  Never from inside a lifecycle effect — that would await the task's own mailbox.
- Rendering copies the hibernated precedent exactly (grey + dashed muted badge) in
  `TaskCard.tsx`, `ActiveTaskRow.tsx` and `ActivityOverview.tsx`. Unlike
  hibernation it forbids nothing: the card still drags, opens and changes column.

## Risks

- A dead session is noticed at boot only. Killing tmux under a running app leaves
  the task looking live until the next restart or until it is opened.
- Moving a disconnected task between active columns re-infers `running`
  (`moveTransition`'s `nextRuntime`), clearing the badge while the session is
  still gone. Pre-existing optimism in the machine, not introduced here.

## Alternatives considered

- **A persisted `Task.disconnected` flag** — a second source of truth for
  something `runtimeState` already records, and a new field written into shared
  on-disk state for no gain.
- **Probing liveness from the renderer** — a per-task RPC poll to answer a
  question the boot probe already answered once.
- **Reusing `bootObserved` for the attach path** — its name would then lie, and
  its reality payload carries worktree/branch facts an attach does not know.
