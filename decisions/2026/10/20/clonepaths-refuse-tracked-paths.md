# clonePaths refuse tracked paths; explicit `clonePaths: []` wins

## Context

A clone deletes its destination before copying (`copyIntoPlace` in `src/bun/cow-clone.ts`). Auto-detection put a tracked `build/` source folder into `clonePaths`, so every new worktree traded its fresh checkout for the project root's older working copy (#2026). The config files could not turn it off, because `effective()` in `src/bun/repo-config.ts` treated every empty array as "not configured" (`empty-array-config-fallthrough`, #378).

## Investigation

`git ls-files -- <path>` lists tracked descendants, but silently matches nothing past a symlink (`link/x` where `link -> src`), so the check runs on the path with its parent chain resolved through `realpath`. On case-insensitive filesystems `Build` is `build`, so macOS/Windows use `:(literal,icase)` pathspecs.

## Decision

`clonePaths()` runs one batched `git ls-files` per root (worktree, then project root) before copying and refuses any path that covers a tracked file, resolves outside the root, or cannot be checked because git failed. A refusal is a `CloneResult.error`, so it reaches the existing "did not reach this worktree" task notice with an actionable message. `detectClonePaths()` drops tracked paths and detects nothing when git fails. `EXPLICIT_EMPTY_ARRAY_KEYS` makes `clonePaths: []` an explicit value in every cascade, provenance and save-routing path; every other array keeps the #378 fall-through.

## Risks

A pre-#378 phantom `clonePaths: []` still committed in a repo now disables cloning instead of falling through; `dev3 config show` names the file, so it is diagnosable. A tracked path is skipped whole — its ignored contents are not partially copied. Up to two extra git processes per task launch. Anything calling `clonePaths()` on non-git directories now gets refusals — the macOS release probe (`scripts/ffi-clonefile-probe.ts`) therefore `git init`s its temp dirs in `release-build-macos.yml`. A sparse-checkout worktree refuses paths inside excluded areas, since the index still tracks them.

## Alternatives considered

- Copy only the untracked/ignored part of a tracked path: needs per-file merging into a checkout, far more surface than a skip, and the clone list is meant for output, not source.
- A separate opt-out value (`false`, `"none"`) instead of `[]`: invents schema when `[]` already reads as "clone nothing".
- Making every empty array explicit: reopens #378 for `sparseCheckoutPaths` without evidence anyone needs it.
