# 056 — Separate `titleEditedByUser` flag from `customTitle`

## Context

Re-opened bug from issue #583 (originally #564): a task's title freezes forever and is never refined by later agents. The user can see `customTitle = null` on a freshly created task — yet on tasks that have lived for a while, the title locks on whatever the first agent named it.

Decision 052 introduced `customTitle` and used `customTitle != null` as the proxy for "user edited the title — never overwrite". Decision 055 carried `customTitle` across `spawnVariants` / `addAttempts`. Both made the original UI bug go away, but they kept conflating two distinct write sources behind the same field.

## Investigation

`customTitle` is written from four places:

1. `CreateTaskModal` → `api.request.renameTask` — **user** edit through the UI
2. `InlineRename` → `api.request.renameTask` — **user** edit through the UI
3. `dev3 task update --title …` (`cli-socket-server.ts` `task.update`) — **agent** rename via CLI
4. `spawnVariants` / `addAttempts` — propagation from source task to the new variants/attempts

Cases 1, 2 must lock the title. Case 3 must NOT — it is the agent renaming a too-long auto-title to something short, and a follow-up agent in a later session should still be free to do the same. Case 4 should inherit whichever state the source task had.

Because the marker shown to agents (`dev3 current` → "(user-edited — do NOT rename)") and the CLI overwrite-guard in `task.update` both keyed off `customTitle != null`, case 3 silently set the lock on its own writes. From then on every later agent saw the marker and refused to rename — exactly the user-reported symptom of "the title never changes anymore".

## Decision

Add a separate boolean `titleEditedByUser` to `Task` and drive every "is this title user-owned?" decision off the flag, not off `customTitle`.

- `src/shared/types.ts` — new `titleEditedByUser?: boolean` on `Task`.
- `src/bun/data.ts` — backfill missing values to `false` in `rawLoadTasks`; accept it in `addTask` extras.
- `src/bun/rpc-handlers/task-lifecycle.ts` — `renameTask` (only callable from the UI) writes `titleEditedByUser: true` for any non-null custom title, and `false` when the user resets it. `spawnVariants` and `addAttempts` carry the flag along with `customTitle`.
- `src/bun/cli-socket-server.ts` — `task.update` guards on `task.titleEditedByUser`, NOT `customTitle`. CLI writes never set the flag; clearing the title via `--title ""` also drops the flag.
- `src/cli/commands/current.ts`, `src/cli/commands/task.ts` — the "(user-edited — do NOT rename)" marker is shown only when the flag is `true`.

Migration is mild: existing tasks default `titleEditedByUser` to `false`, so agent-set `customTitle`s become rewritable again, while legitimately user-typed titles will be re-locked the next time the user renames through the UI. There is no programmatic way to recover the original intent for legacy data — that is acceptable.

## Risks

- Tasks whose `customTitle` was actually typed by the user in the UI before this change are no longer flagged. Until the user renames them again, an agent could rewrite them. Low impact in practice — most legacy `customTitle`s in this repo's data are agent-set.
- A test or external script that called `data.updateTask` with a manual `titleEditedByUser` write will still work, but should normally go through `renameTask` to stay future-proof.

## Alternatives considered

- **Tag `customTitle` with a discriminated union** (`{ value, source: "user"|"agent" }`). More expressive but forces a migration of every reader of `task.customTitle` across renderer, CLI, and backend.
- **Stop writing `customTitle` from the CLI entirely; let agents write `title` directly.** Breaks the invariant that `title` is the auto-generated description prefix, and complicates the description-edit code paths in `editTask`.

A separate boolean is the smallest surface change that splits the two semantics cleanly.
