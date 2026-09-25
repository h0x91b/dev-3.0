# Moving a running task to To Do is a consented reset

## Context

A bug hunt (agent S, finding C1) traced a work-loss path, which was then reproduced in a temp repo. A plain move from an active column to To Do left the worktree, the branch and the agent running. The next activation then ran `createWorktree`, which reclaims the task's own path and runs `git branch -D dev3/task-<id>`. The commits became unreachable. Hooks from the still-running agent (`task move --status in-progress`, `task.agentHook`, `task.claudeStopFailure`) could trigger that activation silently. The user ruled on the semantics: moving an active task to To Do is a destructive reset, like cancellation, but it keeps the card. It must only ever happen after an explicit warning and consent.

## Investigation

- The design went through four rounds of safety review by Seq 2003 (reports `2003-003` to `2003-005`).
- A persisted "resetting" runtime was rejected. Older app versions read an unknown runtime as `running`, then erase it to `idle` at boot. Reusing `tearing-down` with `stage: "todo"` is worse: older versions read any non-`cancelled` stage as *complete the task*.
- Binding consent to the `movements[]` log was rejected. It keeps only 50 entries, and a working agent adds two or more per prompt.
- tmux `new-session -c <missing dir>` exits 0 and starts the pane in `$HOME`. Several launchers checked only that `worktreePath` was non-null.

## Decision

- **The machine refuses the plain move and the silent restart** (`lifecycle/machine.ts` `moveTransition`):
  - active (or a card owning a worktree) → `todo`: refused with `RESET_REQUIRES_CONSENT_ERROR`. `force` does not bypass it.
  - `todo` + worktree → active: refused with `TODO_OWNS_WORKTREE_ERROR`.
  - `todo` → active needs `preparation` (every launch pipeline) or `explicitLaunch`: the quick shell, or `task.move` with no task context. `explicitLaunch` is an out-of-task origin, not an identity, and never counts as reset consent.
- **Hook entry points no-op on `todo`**: `getAgentHookTargetStatus`, own-agent `task.move`, and `task.claudeStopFailure`.
- **`resetRequested { consent }`** (`resetTransition`) runs the cancellation teardown in the same order with the same abort points. No lifecycle state (status, runtime, pointers) is persisted until one compare-and-set write (`persistResetTask`, via `data.updateTaskWith`). The only earlier writes are the durable recovery note per deleted branch, written without a push so the "shutting down" view stays, and the port release cancellation also does. A crash leaves an ordinary active task, and the user confirms again.
- **Consent binding.** Consent is `{ worktreePath, lifecycleStartedAt }` (`TaskResetConsent`). The reset clears `lifecycleStartedAt`, so a relaunch at the same path gets a new stamp. When the field is absent on both sides, the binding falls back to the path alone. A task's pending `reset` approval is voided when its run ends.
- **Branches** (`git.removeWorktree` with `branchPolicy: "task-owned"`): the live branch and the recorded branch are judged separately.
  - Deleted: `dev3/task-<id>`, or a branch whose reflog shows a rename from it. A variant-looking name (`<existing>-vN`) proves nothing — `createWorktree` adopts a user's branch of that name — so it is kept.
  - Everything else is kept.
  - A task note (worded as intent, with a recovery command) is written before each delete. If the note fails, or git refuses the delete, the branch is kept and the outcome is reported.
- **Entry points.** The UI calls `resetTaskToTodo` only after `confirmTaskReset` (in-app `confirm()`, danger, always shown). The CLI `--status todo` goes through a `reset` approval kind that is never auto-approved (exit 27 when not approved).
- **A later start never destroys what an earlier run left holding work** (`git.createWorktree`). A read-only preflight runs before the destructive stale-folder reclaim. It checks for a non-empty folder git cannot inspect, dirty or untracked files, a detached HEAD with commits no ref reaches, and a leftover `dev3/task-<id>` with commits reachable from no other branch, remote or tag. Any of these, or any check that fails, raises `WorkspaceReclaimRefusedError`: nothing is touched. The preparation failure then carries `preserveWorkspace`, so it runs no cleanup script or removal either. A clean leftover is still reclaimed, and its branch is deleted with `git update-ref -d <ref> <tip>`, which refuses if the tip moved. Ignored files do not count as work.
- **The preparation-failure cleanup judges before it destroys** (`judgeFailureWorkspace` in `preparationFailureEffects`, which also covers a boot interrupted mid-preparation). It runs the same preflight on the derived folder. On a refusal, the cleanup script, the reaper and the removal are skipped, and the refusal text is appended to `preparationError`. The removal itself uses `branchPolicy: "unique-kept"`, which keeps a branch holding commits reachable from it alone and deletes through a compare-and-swap. The worktree-add retry loop never deletes a branch that existed before the call.
- **Variants start fresh, deliberately changing re-run semantics.** A variant launch no longer adopts an existing `<existing>-vN`. It creates a new branch at the verified current tip of the base. When the base has a remote counterpart — it is a remote-tracking ref, or a local branch with an upstream or an `origin/<name>` — the remote is probed and fetched first. A branch the remote answers without (merged and deleted, say) is `base-missing`. An unreachable remote is `base-unverified`, a retryable refusal. A local branch and remote that diverged is `base-diverged`, and dev3 picks neither. A local branch behind its remote starts from the remote tip; one ahead starts from local. There is never a stale fallback. A local branch with no remote counterpart is its own base. The name is the first free one of `-vN`, `-vN-2` … `-vN-20`: free locally and on every remote, `check-ref-format` valid, created only with `-b`, and a collision moves on to the next suffix. Nothing in that path deletes or renames a branch. The old branch is kept untouched. A best-effort task note names the kept and the new branch and the base sha. The cost, named: a re-run after a failed preparation also starts on a new name instead of resuming its earlier variant branch (whose commits stay on it), and every reset or re-run of a variant can leave one more preserved branch. Nothing is cleaned up automatically. After 20 names the start is refused with cleanup instructions.
- **A failed run's own folder can block the next start**, deliberately: the failure judge does not exempt a folder this preparation created. Setup or `clonePaths` leftovers that are neither committed nor ignored make it refuse, and the next start's preflight refuses on the same folder until the user removes it. Any error in the judge itself also keeps the folder (fail closed).
- **Ignored files are not checked** by any of these preflights. A folder whose only extra content is `.gitignore`d is reclaimed or removed. This is a documented limit, not a claim that such files are disposable.
- **Fail-closed launch guard.** `assertTaskWorkspacePresent` runs first in every task-scoped launcher, before any trust or hook write. `TmuxClient` refuses a missing path cwd as a backstop. A permission error reads as `unreadable`, not missing, so a lost Full Disk Access never gets destructive recovery offered.

## Risks

- **An anchor stamped mid-dialog.** When the anchor is absent at dialog open and stamped while the dialog is open, the reset is refused as stale and nothing is deleted. Harmless.
- **An anchor absent on both sides.** The binding is `worktreePath` alone. A same-path relaunch needs the run to end first, which voids the pending approval in this instance. That leaves two accepted gaps, both requiring a relaunch that never enters `in-progress`: a relaunch within the seconds a UI confirm is open, and a second app instance relaunching while this instance's request is still pending.
- **Two instances.** Each could run a teardown for two separate consents. The CAS stops either from clobbering the other's write.
- **Unshown new work.** Work created while the dialog is open is destroyed without being listed.
- **Reset after a crash-and-cleanup.** A crash after the cleanup script ran leaves an active task whose containers may already be stopped.
- **Older versions.** They can still produce a To Do card with a worktree. This version refuses to start it until it is reset.
- **Cycle time.** The Productivity cycle time now starts from the fresh run.
- **C2 is not fixed here.** C2 is the complete/cancel branch-deletion bug from the same hunt, and it is unchanged. `todo-reset-git.test.ts` records it.

## Alternatives considered

- **Resume the existing worktree on re-activation.** The user overruled this assumption.
- **A persisted `resetting` runtime, or `tearing-down` with `stage: "todo"`.** Rejected: both misread by N-2 versions, as described above.
- **A movement-log anchor.** Rejected: it evicts itself on long runs.
- **Refusing the reset from the CLI.** This path has less code, but the user asked for CLI parity with cancellation.
- **Fixing C2 here.** Kept as a separate task on the coordinator's scope ruling.
