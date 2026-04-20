# 037 — projectSlug dash escape

## Context

`projectSlug(projectPath)` mapped `/` → `-` without escaping existing
`-` characters. Two distinct project paths such as `/foo/bar-baz` and
`/foo-bar/baz` both collapsed to `foo-bar-baz`, so both projects shared
the same `~/.dev3.0/data/<slug>/tasks.json` directory — silent data
corruption waiting to happen.

## Decision

Escape `-` to `--` before replacing `/` with `-`:

```
/foo/bar-baz  → foo-bar--baz
/foo-bar/baz  → foo--bar-baz
```

See `projectSlug()` in `src/bun/git.ts`. A one-shot migration in
`src/bun/data.ts` (`migrateProjectSlugDirs`) renames
`~/.dev3.0/data/<legacy-slug>` → `~/.dev3.0/data/<new-slug>` the first
time `loadProjects()` runs after this change, so existing installs do
not "lose" their task lists.

## Risks

- Worktree directories under `~/.dev3.0/worktrees/<slug>/…` are **not**
  migrated. Renaming them would break git's internal `gitdir` pointers
  and the `task.worktreePath` stored in `tasks.json`. Existing worktrees
  keep their old path until the task completes; new worktrees are
  created under the new slug.
- Tests that hardcoded the old slug (`tmp-test-project`) were updated
  to `tmp-test--project`.

## Alternatives considered

- URL-encoding `/` to `%2F` — collision-free but produced unfriendly
  directory names and still broke all existing installs.
- Hashing the full path — collision-free and opaque, but loses all
  human readability in `~/.dev3.0/data/`.
- Detecting collisions only when they occur — would require scanning
  every other project on every write, and would make the slug a
  non-deterministic function of the path.
