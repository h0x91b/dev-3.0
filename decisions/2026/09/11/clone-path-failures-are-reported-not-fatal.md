# Clone-path copy failures are reported on the task, not fatal to the launch

## Context

`cloneSingle` ran a plain `cp -R` as the last step of the CoW cascade and never read
its exit code. A failed copy logged `Copied via cp -R`, the summary counted the path
as `copy`, and the worktree simply lacked it (issue #1728, reported by @diverru).
This matters more than a slow install: `clonePaths` is the only preparation hook that
finishes **before** the agent launches, while `setupScript` in the default `parallel`
mode starts alongside an already-running agent pane. A git-ignored file the agent
reads once at startup can arrive only through `clonePaths`.

## Investigation

`runCowClones` (`src/bun/lifecycle/executor.ts`) discarded the `CloneResult[]`
entirely, and `CloneResult.error` existed but was never written by anything. The
Windows branch had the opposite failure mode: a rejected `node:fs` `cp` propagated
out of `Promise.all` and aborted the whole preparation.

## Decision

`run()` in `src/bun/cow-clone.ts` now returns `{ code, stderr }` with stderr piped;
the final `cp -R` and the Windows `cp` turn a non-zero exit or a throw into a
`CloneResult` carrying `error` (last stderr line + exit code), logged at error level.
Intermediate cascade steps stay at debug — a filesystem without reflink fails every
time. `runCowClones` writes the failures to `Task.cloneFailures` and pushes
`taskUpdated`; `TaskTerminal` renders them as a dismissible strip stacked with the
setup-failure strip, cleared by `dismissCloneFailures` or by the next launch.

**A failed clone path does not abort the launch.** The worktree is usable and one
missing cache should not cost the user the task; a visible notice beats a dead
launch. A *missing source* stays a silent skip (`skipped: true`) — a clone list is
shared across machines, so an absent path is expected, not a fault.

## Risks

`Task.cloneFailures` is additive on disk; an older app version ignores it, so the
notice is invisible there but nothing breaks. Piping stderr means the child's stderr
is drained by us rather than inherited — `cp` writes little, and the reader runs
before `await proc.exited` so a full pipe cannot deadlock it.

## Alternatives considered

- **Throw and fail preparation** — surfaces through the existing `preparationError`
  UI with no new field, but one unreadable path would block the whole task.
- **A transient toast / attention badge** — no persistence: a user who was not
  looking at the app during preparation would never learn about it.
