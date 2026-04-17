# 037 — Operational config: fall back to worktree when project-level script is empty

## Context

`resolveOperationalProjectConfig()` in `src/bun/rpc-handlers/settings-config.ts`
resolves `setupScript`/`devScript`/`cleanupScript`/`setupScriptLaunchMode` from
the main project path (`project.path`) rather than the task's worktree. This was
introduced in 613c3650 to stop older task branches from running a stale,
committed `.dev3/config.json` copy.

The trade-off broke the common "new project" flow: a fresh clone has no
`.dev3/config.json` on `main`. The user configures scripts in a feature branch
worktree (ProjectSettings → Worktree tab → Save, which writes into the
worktree's `.dev3/config.json` with auto-commit). Dev-server button turns green
(the UI correctly reads from the worktree via `getResolvedProject`), but
clicking it fails with `No dev script configured` — because
`resolveOperationalProjectConfig` shadows the worktree value with an empty
string coming from DEFAULTS.

## Decision

Keep the "project-level wins" behaviour for stale-branch protection, but treat
an empty / whitespace-only project-level script as "not configured" and fall
back to the worktree-resolved value. Same fallback for `setupScriptLaunchMode`
(via `??`).

Implemented with a local `pickScript()` helper in
`resolveOperationalProjectConfig()`.

## Risks

- If a user **intentionally** blanks `devScript` at the project level while an
  older worktree still has one committed, we will now run the worktree's
  script. This is a mild regression of the 613c3650 protection, but the
  opposite (ignoring the worktree entirely for new projects) is strictly worse:
  there is no UI path to set the script only at the project level before the
  worktree exists.

## Alternatives considered

- **Copy `.dev3/config.json` into `project.path` on first save.** Would fix the
  symptom, but spreads "source of truth" across two places and conflicts with
  the worktree-only save UX.
- **Detect "is project.path configured at all" flag and use worktree config
  when no repo/app/local file exists there.** More complex; the empty-string
  fallback is simpler and cheaper per-field.
