# 020 — Empty array config fallthrough

## Context

Clone Paths (CoW) configured in project settings were not being copied into worktrees (#378). Users would set clone paths in the "Project Config" tab, but new worktrees would not receive the cloned files.

## Investigation

The 4-level config resolution (`resolveProjectConfig` in `repo-config.ts`) uses nullish coalescing (`??`) to cascade through config layers: local > repo > app > project > defaults. The `??` operator only skips `null`/`undefined`, not empty arrays.

`sanitizeConfigPaths` in `ProjectSettings.tsx` converted `undefined` clonePaths/sparseCheckoutPaths to `[]` via `(rest.clonePaths ?? []).filter(...)`. When any worktree repo config was saved (e.g., changing just `setupScript`), this phantom `clonePaths: []` was written to `.dev3/config.json` and auto-committed. All future worktrees inherited this file, and the empty array at priority level 2 (repo config) shadowed the real clone paths at level 4 (project settings).

## Decision

Two-pronged fix:

1. **`sanitizeConfigPaths`** (`src/mainview/components/ProjectSettings.tsx`): Only include `clonePaths`/`sparseCheckoutPaths` in output when they were actually present in the input config. Prevents creating new phantom entries.

2. **`resolveProjectConfig`** (`src/bun/repo-config.ts`): Added `effective()` helper that treats empty arrays as `undefined` for cascade purposes. Empty arrays from file-based config sources (local, repo, app) fall through to lower-priority layers. This handles existing phantom entries in committed `.dev3/config.json` files.

## Risks

- If a user intentionally sets `clonePaths: []` in `.dev3/config.json` to disable cloning for a branch, the empty array will now fall through instead of overriding. This is an unlikely use case — disabling cloning is better done by not configuring clone paths at any level.
- The `effective()` helper applies to ALL config keys, not just array fields. For non-array values this is a no-op since they can't be empty arrays. Boolean `false` and empty strings are unaffected.

## Alternatives considered

- Only fixing `sanitizeConfigPaths` without the `effective()` helper: would prevent new phantom entries but not clean up existing ones. Users with already-committed `.dev3/config.json` containing `clonePaths: []` would still be affected until they manually edit the file.
- Using `||` instead of `??` in the cascade: too broad — would also skip `false` booleans and empty strings, changing semantics for other config fields.
