# Comparison base in a repo with no git remote

## Context

A project added from a local folder (`git init`, commits, no `origin`) still showed
`vs origin/main` everywhere: the task git bar's "Show diff vs origin/main", the
branch diff header "Compared to origin/main", and Project Settings → Diff
Comparison Default pre-filled with `origin/main`. `origin/main` does not exist
there, so `getBranchStatus` failed on every 15s poll
(`fatal: ambiguous argument 'origin/main...HEAD'`) and the branch diff rendered
"No changes to show" — a false negative, not a missing feature.

## Investigation

The backend cascade was already right. `git.detectDefaultCompareRef` checks for an
`origin` remote and returns the bare base branch when there is none, and
`dev3 config show` in the repro repo printed `defaultCompareRef  main  default`.

The defect was upstream of it: `addProjectImpl` returned the **raw** projects.json
record, never passed through `repoConfig.resolveProjectConfig`. `getProjects` is
not polled, so the renderer kept that unresolved object — `defaultCompareRef:
undefined` — for the rest of the session, and both the renderer
(`useTaskBranchStatus`) and the server (`getBranchStatusImpl`) expanded the empty
value to `origin/<base>` unconditionally. Reloading the app made the label correct,
which is why the bug only ever showed right after adding a project.

## Decision

1. `addProjectImpl` (`src/bun/rpc-handlers/app-handlers.ts`) resolves the project's
   config before returning it; a resolution failure still returns the raw record.
2. `resolveCompareRef` (`src/bun/rpc-handlers/git-operations.ts`) is the single
   server-side answer to "what do we compare against": an explicit ref wins,
   otherwise `git.detectDefaultCompareRef` decides. Used by `getBranchStatus`,
   `getUnsavedWork`, `getTaskDiff` and `healDeadCompareBase`. No caller spells
   `origin/${baseBranch}` any more.
3. The **local base branch** is the default with no remote (the user's call). Not
   "comparison disabled": in a local-only repo the local base is a perfectly good
   base, and disabling would remove a working feature.
4. `BranchStatus.hasRemote` carries the fact to the renderer, which disables
   Push / Create PR / PR + auto-merge with `infoPanel.noRemoteDisabled` and drops
   the `origin/<base>` row from the compare-ref menu. Merge stays live — merging
   into the local base needs no remote.
5. `TaskDiffFallbackReason` gained `missing-compare-ref`: a compare ref that is not
   in the repo produces an explicit "Nothing to compare against", never an empty
   diff.
6. **A remote added later** is picked up on its own, within the 10-minute
   `detectDefaultCompareRef` cache TTL. Deliberately no invalidation hook and no
   prompt: the existing cache already converges, and neither extra git polling nor
   another notification earns its cost.

## Risks

- Up to 10 minutes of stale `main` (instead of `origin/main`) after a user adds a
  remote to an existing local project. Accepted, per decision 6.
- `getUnsavedWork` now calls `detectDefaultCompareRef`. Its "three cheap git reads"
  promise holds because that function is memoised for 10 minutes; the first call
  per project pays a few local git spawns.
- `getBranchStatus` adds one `git remote` call per poll for `hasRemote`.

## Alternatives considered

- **Disable comparison entirely with no remote.** Honest but removes a feature that
  works; a local base branch is a real base.
- **Pin HEAD at project creation.** Answers "what did I change since I added this
  project", but drifts from the base branch over time and needs a new persisted
  field in `projects.json`.
- **Make `git.getTaskDiff`'s own `origin/${baseBranch}` default remote-aware.** Left
  as is: every production caller now passes a resolved ref, and the low-level
  default is reached only by tests.
