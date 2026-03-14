# 017 — Repo-local project config (.dev3/config.json)

## Context

Project settings (scripts, clone paths, base branch) lived only in `~/.dev3.0/projects.json` — machine-local and not shareable. Team members had to manually configure each project on every machine. GitHub issue #249 requested storing settings in the repo.

## Decision

Introduced a two-file config system inside each repo:

- **`.dev3/config.json`** — committed to git, shared across the team. Primary source of project settings: `setupScript`, `devScript`, `cleanupScript`, `clonePaths`, `defaultBaseBranch`, `peerReviewEnabled`.
- **`.dev3/config.local.json`** — git-ignored, for machine-specific overrides.

**Merge priority** (lowest → highest): `.dev3/config.json` (repo) → `.dev3/config.local.json` (local). Fields not set in either file use defaults. `projects.json` settings are **not used** — that file only stores project metadata (id, name, path, createdAt).

**Migration**: On first load, if no `.dev3/` config files exist but `projects.json` has non-default settings, they are automatically copied to `.dev3/config.json`. This is a one-time operation.

**Resolution happens at the RPC layer**. `data.ts` returns raw `projects.json` data unchanged. The `getProjects` RPC handler runs migration and then `resolveProjectConfig()` to populate settings from `.dev3/` files. `activateTask`/`runCleanupScript` also resolve before using settings.

**UI**: Two-tab layout in Project Settings — "Repo Config" (`.dev3/config.json`) and "Local Overrides" (`.dev3/config.local.json`). Each tab edits its own file directly.

**Agent skill**: A dedicated `dev3-project-config` skill is installed alongside `dev3`, teaching AI agents the schema, merge priority, and when to create/modify config files. Agents are instructed to ask users whether to save to repo (shared) or local (personal).

Key code: `src/bun/repo-config.ts` (all I/O + migration), `src/bun/rpc-handlers.ts` (resolve in `getProjects`/`activateTask`/`runCleanupScript`), `src/bun/agent-skills.ts` (skill content).

## Risks

- **Migration edge cases**: If `projects.json` has settings that differ from what the user actually wants in the repo, the auto-migration might create an unwanted `.dev3/config.json`. Mitigation: migration only runs once and only if no `.dev3/` files exist.
- **File system permissions**: `.dev3/config.json` is read from `project.path` (main worktree), which should always be accessible.

## Alternatives considered

- **Three-level merge (global < repo < local)**: Initially implemented but removed — the global level (`projects.json`) was confusing and redundant once `.dev3/config.json` became the primary source.
- **Single file only** (no `config.local.json`): Rejected because machine-specific paths, secrets, or personal preferences need a git-ignored location.
- **Merge in data layer**: Rejected because internal operations like `updateProject` would silently merge repo config into the saved data, causing drift.
