# 065 — Explicit 50% rename detection for diffs

## Context
The task diff view rendered renamed files as a full delete of the old path plus a
full add of the new path — making it look like the entire file changed when only a
few lines actually differed.

## Investigation
Two independent causes in `src/bun/git.ts`:
1. **Config dependence.** The per-file patch commands (`buildArgs` in `getTaskDiff`)
   and the numstat/shortstat summary calls did not pass any rename flag, so they
   inherited the user's `diff.renames` setting. With `diff.renames=false`, git emits
   a delete + add patch.
2. **Threshold too strict.** `listDiffEntries` used `--find-renames=90%`. A rename
   carrying moderate edits (e.g. ~70% similar) falls below 90%, so git split it into
   separate `D` + `A` name-status entries → two diff cards, each showing the whole file.

## Decision
Introduced `RENAME_DETECTION_ARGS = ["--find-renames", "--find-copies"]` (git's
default 50% similarity, passed explicitly) and applied it to every diff invocation:
`listDiffEntries`, all four per-file `buildArgs`, `getDiffShortStat`,
`getUncommittedChanges`, and `getBranchDiffStats`. The name-status classification and
the per-file patch now use the same detection, so a rename-with-edits is one
`renamed` entry with a minimal patch.

## Risks
50% is more permissive than 90%, so unrelated files with ~50%+ overlap could be
paired as a rename. This matches git's own default (git log/show, GitHub) and is the
expected behavior, so the risk is low and consistent with user expectations.

## Alternatives considered
- Keep 90% but pass it explicitly — rejected: still drops moderate-edit renames.
- Recompute the diff in the renderer from `oldContent`/`newContent` — rejected:
  duplicates git's rename logic and the backend already produces the correct patch
  once the flag is passed.
