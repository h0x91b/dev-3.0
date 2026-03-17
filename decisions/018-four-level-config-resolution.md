# 018 — Four-level config resolution

## Context

Project config was split between `projects.json` and `.dev3/config.json` with no clear source of truth. Two bugs exposed architectural problems: AI Review "off" state didn't persist (#336) because `undefined` was serialized as absent in JSON, and dev server ignored worktree-local overrides (#341) because `triggerColumnAgentIfNeeded` read the project object directly without resolving from worktree configs.

## Decision

Introduced a 4-level per-field resolution chain in `resolveProjectConfig()` (`src/bun/repo-config.ts`):

1. `.dev3/config.local.json` in worktree — personal overrides, gitignored
2. `.dev3/config.json` in worktree — branch config, committed to git
3. `~/.dev3.0/data/<slug>/config.json` — app-level project config (new)
4. `projects.json` field values → then `DEFAULTS` — fallback

Per-field, first-defined wins. No deep merge. The app-level config (level 3) is always read from `project.path`, not the worktree path, so it's stable across all worktrees.

UI restructured `ProjectSettings` into 3 tabs: Board (labels/columns, immediate save), Project Config (app-level, with AI Review toggle), Worktree Config (per-task, with task selector and auto-commit for repo config).

## Risks

- The `??` chain treats `undefined` and `null` as "not set", which is correct for optional fields but means you can't explicitly set a field to `null` at a higher priority level to "unset" a lower one. This is acceptable for the current field types (strings, booleans, arrays, objects).
- App-level config lives alongside `tasks.json` in `~/.dev3.0/data/<slug>/`. If users have many projects, this adds one more file per project directory.

## Alternatives considered

- **Deep merge instead of per-field**: Rejected because it creates unpredictable behavior for array fields (clone paths, sparse checkout paths) — users expect replacement, not concatenation.
- **Keep everything in projects.json**: Rejected because it doesn't support per-worktree or team-shared config.
- **Only repo + local (no app-level)**: Rejected because it would force users to commit project-specific settings (like AI Review config) to every repo they use dev-3.0 with.
