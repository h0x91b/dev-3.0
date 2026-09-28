# One engine selects every Codex conversation dev3 resumes

## Context

Issue #1847: a Codex pane with no saved conversation ID was relaunched with `codex resume --last`, which is not
scoped to the task and opened a sibling worktree's live conversation. The only path that still emitted it was
reopen (`prepareTask` → `launchTaskPty(resume=true)` without an id); the null id itself came from the native
backend, whose panes export `DEV3_PANE_ID` while the Codex hook read only `$TMUX_PANE`.

## Investigation

Fixtures on real files (APFS) compared run boundaries for scanned conversations: `header start ≥ lifecycleStartedAt`
3/6, `rollout mtime ≥ lifecycleStartedAt` 2/6, `mtime ≥ worktree folder birth` 4/6, `header start ≥ min(stamp, folder
birth)` 6/6. `lifecycleStartedAt` is a status clock (re-stamped on reopen, stamped mid-run for legacy and imported
tasks), and mtime moves when an old rollout is written again. Setting an older mtime on an APFS folder drags its
birthtime back. A throw during reopen launch becomes `preparationFailed`, whose effects run the cleanup script and
remove the worktree.

## Decision

- `selectCodexConversations` (`src/bun/codex-resume-home.ts`) is the only selector, with a caller intent:
  `explicit-resume` (`resumeTask`: saved id exact, else newest eligible), `automatic-recovery` (newest by mtime among
  eligible, saved id included; refuses rather than falling back when an unbound newer one is contested by another
  recorded pane or any other Codex pane is live), `reopen` (saved id exact, else refuse).
- A scanned candidate must be in `sessions/`, `source=cli`, not a subagent, `cwd ===` the task's managed git worktree
  (Operations folders are never scanned), bound to no pane, start ≥ `max(min(stamp, folder birth), codexScanFloorAt)`;
  neither stamp nor birth → no scan. Account: managed id → that store; `null` → non-managed homes; `undefined` → all,
  more than one store → ambiguous; a recorded mismatch refuses even for a saved id.
- `Task.codexScanFloorAt` (optional, never cleared) is written by `restartTask`, `persistResetTask` (inside its CAS)
  and `persistTerminalTask`, so an ended run stays out of later scans whatever the folder's times.
- `src/bun/codex-task-selection.ts` snapshots all Codex panes, calls the engine once and claims the ids with a
  compare-and-set. Reopen refusal opens the pane with a printed line (`launchTaskPty` `agentRefusal`) plus an
  attention badge, so preparation succeeds and nothing is cleaned up.
- The Codex adapter throws on resume without an id; `buildResumeCommand` returns null.
- Capture: the hook also sends `DEV3_PANE_ID`; without a pane id a Codex session is placed only on a task's single
  pane; an id is recorded only once its rollout exists with `source=cli` and no subagent.

## Risks

- Runs ended by an older app version or by a failed preparation wrote no floor; for them a time-preserving restore
  of the worktree folder can still admit an earlier run's conversation of the same task (never another task's).
- Folder birthtime is unmeasured on Linux/Windows; missing birth degrades to the stamp (legacy/imported refuse).
- "Pane present or unknown = live" and the contest rule refuse more often than strictly necessary.
- Tests: an agent shell's `CODEX_HOME` points at a real store; `src/bun/test-setup.ts` scrubs it and the discovery
  suites run under `__tests__/helpers/fs-root-guard.ts`.

## Alternatives considered

- Stored-id-first for automatic recovery: rejected by the user's ruling (newest wins).
- `mtime ≥ stamp` or folder birthtime alone: refuted by the fixture above.
- Fresh idle Codex on reopen without an id: rejected; it silently starts a new conversation.
- Re-stamping `lifecycleStartedAt` on restart: it feeds reset consent and stats.
