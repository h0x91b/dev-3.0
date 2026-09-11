# Ignoring a repository's dev3 configuration is one flag on the project record

## Context

`.dev3/config.json` and `.dev3/config.local.json` outrank everything dev3 stores itself, and
a Project Settings save of a field a file owns is routed back into that file
(`saveConfigToWinningLayer`). A repo can therefore hand dev3 a `setupScript`, a `devScript`, a
`cleanupScript`, `env` vars and column agents — all of which dev3 executes — and the only way to
override them was to create another file inside the repository (and a `.gitignore` line with it).
Issue #1683 (@Paveltarno) asked for a local opt-out that never touches the checkout.

## Decision

One optional field, `Project.useRepoConfig` in `projects.json` — absent means ON, so every
existing project behaves exactly as before. `repoConfigEnabled()` (`src/shared/types.ts`) is the
single reader. It is deliberately **not** a member of `Dev3RepoConfig`: a repository must not be
able to grant itself back the trust the user withdrew.

The gate sits where the files are opened, `src/bun/repo-config.ts`:

- `resolveProjectConfig` / `resolveOperationalProjectConfig` pass **zero** layers to
  `applyConfigCascade`, so resolution is the Project object then `DEFAULTS`. Every caller of the
  cascade — worktree creation, dev server, cleanup, agent env, column agents — inherits this with
  no change of its own.
- `resolveConfigProvenance` attributes nothing to `repo`/`local`, matching what the cascade did.
- `migrateProjectConfig` returns early: it runs on every project load and would otherwise grow a
  `.dev3/config.json` for a project that has just been told to ignore one.

The RPC boundary (`rpc-handlers/settings-config.ts`) adds what the UI needs: `getProjectConfigs`
and `getRepoConfigSources` return empty without opening a file; `saveRepoConfig` /
`saveLocalConfig` throw; and `updateProjectSettings` routes a save into a file only while the
project reads files **both before and after** the request, so the save that switches the flag off
cannot write one on its way out. `dev3 config export` refuses for the same reason, and
`dev3 config show` labels the file `IGNORED`.

### Provenance of copied values

The hazard is a repo-origin value surviving as a local copy: the Project Settings form is seeded
from the *resolved* project, so saving it while OFF would write a repo script into
`projects.json`. Two things close it. `updateProjectSettings` answers with the re-resolved project
— local values only — and the renderer reseeds the form from that answer. And the toggle saves
alone, carrying nothing but the flag; unsaved edits in the tab were typed against the old
resolution, so the user is asked to discard them rather than having them silently migrate.

### Existing tasks and cleanup

Switching OFF changes nothing that is already running: no process is restarted, no worktree is
removed, no file is deleted or rewritten. It only changes what future resolutions see. Concretely,
a repo-provided `cleanupScript` no longer runs when a task completes — dev3 still removes the
worktree itself, it just does not execute a script it has been told to ignore. Switching back ON
restores every value immediately, because nothing was ever destroyed.

## Risks

A user who turns this off on a project that genuinely needs its repo `setupScript` gets worktrees
with no dependencies installed. It is visible rather than silent: the Project tab carries a note
naming the file that is not being read, and the effective values shown are the ones that will run.

`saveConfigToWinningLayer` is still reachable with a path argument alone; the guard lives in its
one production caller, not in the function. A second caller would have to repeat the check.

## Alternatives considered

**Per-field permissions** (trust paths but not scripts) — the `foreignCode` boundary already does
exactly that for PR branches, and a second, user-facing variant of it turns one checkbox into a
permissions framework. Rejected as out of scope for #1683.

**Reusing `foreignCode`** — it is per task and per branch, keyed to code the user did not write,
and it deliberately keeps reading the project's own checkout. This setting is per project and has
to silence that checkout too.

**Hiding the Worktree Config tab while OFF** — a tab that disappears when a setting flips reads as
a bug. The tab stays and explains itself instead.
