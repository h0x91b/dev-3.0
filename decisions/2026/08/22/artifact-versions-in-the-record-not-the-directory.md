# Artifact versions live in the task record, not in the directory layout

## Context

`dev3 show-artifact` created a brand-new artifact on every call, so a report revised
across a long task piled up as near-identical rows — one task passed 99 — and the user
had to guess which row was current. The ask was versioning: one row per artifact, a
switcher in the viewer, older versions still reachable.

The hard constraint is not the model, it is `~/.dev3.0`. That directory is shared with
every other installed version of the app (see the on-disk invariants in `AGENTS.md` and
`decisions/2026/04/20/revert-project-slug-dash-escape.md`): no renames, no destructive
load-time migration, and what we write stays readable by older versions.

## Decision

Versioning is three additive optional fields on `SharedArtifact` (`src/shared/types.ts`):
`groupKey`, `version`, and `previousVersions[]`. The record's top-level fields always
describe the **newest** version, so every existing reader — viewer, download, open-in-
browser, unread badge, counts — keeps working with no knowledge of versions, and an older
app version opens the newest artifact normally. Records written before this change carry
none of the fields and read as a single version 1.

The **directory layout does not change at all**: one `shared-artifacts/<uuid>/` dir per
publish, exactly as before. Grouping happens in the task record only. Nothing under
`~/.dev3.0` is renamed, moved, or deleted by this feature.

Pure model and helpers: `src/shared/artifact-versions.ts` (`artifactGroupKey`,
`appendArtifactVersion`, `artifactAtVersion`, `droppedArtifactVersions`). Publish path:
`ui.show-artifact` in `src/bun/cli-socket-server.ts`. UI: `ArtifactVersionPicker.tsx`
inside `TaskArtifactViewer.tsx`, which hands an older version to the unchanged
`readArtifactContent` RPC as a projected record.

Grouping key: `--artifact-id <slug>` wins, else the normalized title; `--new` mints a key
nothing can match. Retention: 20 versions per artifact.

## Risks

- **A reworded or typo'd title forks a new artifact.** Accepted; `--artifact-id` is the
  stable-identity escape hatch, and the CLI/skill text now says so.
- **Two genuinely different reports sharing one title merge** into one version list.
  Accepted for the same reason, with `--new` as the escape hatch.
- **Past 20 versions the older files exist on disk but are unreachable from the UI.** The
  viewer states how many were dropped rather than losing them silently. Deliberately not
  cured by deleting the pruned dirs: the cost of unreachable files is disk, the cost of a
  wrong delete under `~/.dev3.0` is somebody's work, and those are not comparable.
- **An existing pile of rows only collapses the next time that title is published.** The
  publish path folds same-key records lazily and idempotently instead of migrating at
  load time, which the on-disk invariants forbid.

## Alternatives considered

- **A startup migration collapsing same-title records.** Rejected: a destructive load-time
  rewrite of every user's `tasks.json` is exactly what the invariants forbid, for a
  cosmetic gain over the lazy collapse.
- **A separate `SharedArtifactGroup` type wrapping versions.** Rejected: it reshapes what
  older app versions read and forces every existing consumer to be rewritten, buying only
  the removal of a mild asymmetry (the newest version being the record itself).
- **`shared-artifacts/<id>/v<N>/` version directories.** Rejected: it moves the storage
  layout for no gain, since an absolute `storedPath` per version already does the job.
- **A second prev/next arrow pair in the viewer header for versions.** Rejected on UX
  grounds: it reads as a duplicate of the artifact pager sitting next to it. One chip
  opening a labelled list, rendered only when more than one version exists.
- **Extending the mechanism to `dev3 show-image` in the same change.** Out of scope by
  instruction. It would be cheap structurally — `SharedImage` has the same shape — but
  images have no title, so grouping them needs an explicit key first.
