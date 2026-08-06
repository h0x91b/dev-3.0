# 102 — CLI data-layer lost-update races and short-ID prefix guards

## Context

A bug-hunt over the data layer surfaced four defects in how the CLI socket server
and the CLI-side ID resolver mutate `tasks.json` / `projects.json`.

## Investigation

- `note.add`, `note.delete` and `label.create` (and the project-label removal in
  `label.delete`) in `src/bun/cli-socket-server.ts` rebuilt the whole array from a
  snapshot read **before** taking the file lock, then wrote it back with
  `updateTask`/`updateProject`. Two concurrent writers (routine for parallel
  bug-hunters) both read the same snapshot; the last writer silently dropped the
  other's note/label. The RPC twins in `rpc-handlers/notes-labels.ts` already did
  this correctly via `updateTaskWith`/`updateProjectWith` (recompute inside lock).
- `expandShortId`/`expandShortProjectId` in `src/cli/context.ts` expanded a short
  prefix to a full UUID with no minimum length and no ambiguity check (first match
  in project-iteration order won). Because the server matches the expanded UUID
  exactly, its own `findByIdPrefix` guard (min 8 chars + ambiguity throw) was
  bypassed — a typo'd `--task` prefix silently mutated an arbitrary wrong task.
- `task.setLabels` resolved label prefixes but passed unresolved IDs through
  ("validation is caller's job"), and the CLI never validated. Garbage label IDs
  were persisted into `task.labelIds` (nothing prunes dangling labelIds), the UI
  rendered zero labels for them, and the CLI still reported success.
- `spawnVariants` deletes the source task but only carried `labelIds`/`customTitle`
  onto the variants, dropping the source's `notes`/`overview`/`userOverview`.

## Decision

- Route all CLI-server note/label mutations through `updateTaskWith` /
  `updateProjectWith` so the array is recomputed inside the per-file lock.
- Give `expandShortId`/`expandShortProjectId` the same threshold as the server:
  a prefix below `ID_PREFIX_MIN_LENGTH` (new shared const in `src/shared/types.ts`,
  = 8) is returned unresolved; a prefix matching >1 entity across all projects
  throws. Context matches stay authoritative and bypass the min-length gate.
- `task.setLabels` throws `Label not found: …` for any unresolved label ID.
- `addTask` gained optional `notes`/`overview`/`userOverview` extras; `spawnVariants`
  now carries them from the source (history is regenerated fresh per new task id).
  `addAttempts` deliberately does NOT carry notes — it keeps the source task, so
  copying would duplicate notes across siblings rather than prevent a loss.

## Risks

- `expandShortId` can now throw on an ambiguous prefix (routed to
  `exitInternalError`). This only affects manual short-prefix input; hooks pass
  full UUIDs or context IDs and are unaffected.
- `task.setLabels` is now stricter; a caller relying on the old pass-through of
  unknown IDs would get an error instead. That old behavior was the bug.

## Alternatives considered

- Deferring ambiguity handling to the server for `expandShortId`: rejected — the
  server cannot see cross-project ambiguity when no `--project` is passed, and the
  CLI already scans all projects, so it is the right place to detect it.
