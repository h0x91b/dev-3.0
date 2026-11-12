# Mark a failed teardown in the persisted runtime

## Context
`TaskTerminal` hides the terminal while a task tears down, because teardown snapshots still carry the old status and worktree and would make it reattach to a dying PTY (h0x91b/dev-3.0#2272). The only signal that survives past the first push is the persisted `runtimeState.runtime === "tearing-down"`. But `teardownFailed` deliberately keeps that runtime so a forced retry and boot recovery can resume cleanup. As a result, a failed teardown left the pane on "Shutting down…" forever.

## Decision
`teardownFailed` (`src/bun/lifecycle/machine.ts`) now sets `failed: true` on the tearing-down runtime and persists it before the recovery push. `TaskRuntimeState.failed` carries it to disk (`executor.ts` `runtimeState`) and back (`state.ts` `runtimeFromTask`). `TaskTerminal` treats only an unfailed tearing-down runtime as shutting down. A retry builds a fresh runtime, which clears the mark.

## Risks
An optional field added in place on `tasks.json`: older versions ignore it, and the path is unchanged. A teardown resumed at boot keeps the mark until it finishes, so the pane shows the session rather than the overlay during that resumed run.

## Alternatives considered
- Gate the pane only on the transient `shuttingDown` flag. Rejected: later teardown snapshots lack it and bring the flash back.
- Have the renderer remember an in-flight move. Rejected: moves from the CLI, agent approvals or merge auto-complete never pass through that renderer.
- Clear the runtime to `idle` on failure. Rejected: that loses the retry and boot-recovery path.
