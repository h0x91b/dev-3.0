# 094 — Unified worktree-first config cascade; drop the app-level layer

## Context

Operational config for a task running in a worktree was resolved by
`resolveOperationalProjectConfig` (then in `settings-config.ts`), which combined
a project-checkout resolution and a worktree resolution with two quirks:
- **Scripts** (setup/dev/cleanup) preferred the **project/main** value over the
  worktree's (anti-stale), while **non-script** fields came **only** from the
  worktree resolution (main's `.dev3` was never consulted for them).
- A latent **app-level** layer (`~/.dev3.0/data/<slug>/config.json`) sat between
  repo and project in the cascade.

Two problems surfaced: (1) the split behavior was surprising and untestable in
integration (the function lived in a heavy module), and (2) the app-level layer
was **dead** — no UI writes it, `dev3 config export` writes `.dev3/config.json`,
and no such file exists on disk for any project.

## Decision

**One uniform cascade for every field** (highest → lowest), in `repo-config.ts`:

1. `<worktree>/.dev3/config.local.json`
2. `<worktree>/.dev3/config.json`
3. `<main>/.dev3/config.local.json`
4. `<main>/.dev3/config.json`
5. project object (`projects.json`, Project Settings UI → Project tab)
6. DEFAULTS

Per field, the highest layer that sets it wins (empty arrays = "not configured",
#378). The worktree always outranks main — including scripts — so a stale/empty
main or project-object value can never shadow a worktree value.

Implementation: a shared `applyConfigCascade(project, layers, compareRefBasePath)`
core powers both `resolveProjectConfig` (single path: `[local, repo]`) and
`resolveOperationalProjectConfig` (worktree+main: `[wtLocal, wtRepo, mainLocal,
mainRepo]`). `resolveOperationalProjectConfig` moved from `settings-config.ts`
to `repo-config.ts` (re-exported for existing importers) so it depends only on
the cascade and is integration-testable with real files.

The **app-level layer was removed entirely** — `loadAppConfig`/`saveAppConfig`/
`hasAppConfig`, the `saveAppConfig` RPC, the `getProjectConfigs.app` field, and
`ConfigSource`'s `"app"` member are all gone (no deprecated dead code).

## Risks

- **Behavior change:** when both main and worktree define a script, the worktree
  now wins (was: main). The original bug this guarded against (empty main
  shadowing a worktree script) is structurally impossible now — main/project sit
  below the worktree in one cascade, so an empty higher value never shadows.
- A long-lived branch with an outdated committed `devScript` will run that
  branch's script rather than main's. Accepted: the branch's own config is
  authoritative for that task.

## Alternatives considered

- **Keep the script special-casing (main-first) + worktree-first for the rest.**
  Rejected — non-uniform and confusing; the user wants one predictable order.
- **Keep app-level config as a reserved layer.** Rejected — it is unwritten and
  fileless; per the repo's no-deprecated rule, dead paths are removed, not kept.
- **Heavy-mock integration test instead of moving the function.** Rejected —
  moving it to `repo-config.ts` is the real fix; the function never belonged in
  the dependency-heavy `settings-config.ts`.
