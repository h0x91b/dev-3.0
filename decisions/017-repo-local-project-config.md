# 017 — Repo-local project config (.dev3/config.json)

## Context

Project settings (scripts, clone paths, base branch) lived only in `~/.dev3.0/projects.json` — machine-local and not shareable. Team members had to manually configure each project on every machine. GitHub issue #249 requested storing settings in the repo.

## Decision

Introduced a two-file config system inside each repo:

- **`.dev3/config.json`** — committed to git, shared across the team. Contains shareable fields: `setupScript`, `devScript`, `cleanupScript`, `clonePaths`, `defaultBaseBranch`, `peerReviewEnabled`.
- **`.dev3/config.local.json`** — git-ignored, for machine-specific overrides.

**Merge priority** (lowest → highest): `projects.json` (global) → `.dev3/config.json` (repo) → `.dev3/config.local.json` (local).

**Merge happens at the RPC layer**, not the data layer. `data.ts` returns raw `projects.json` data unchanged. The `getProjects` RPC handler and `activateTask`/`runCleanupScript` apply `mergeRepoConfig()` before using settings. This keeps internal data operations (updates, migrations) working on raw data without merge side effects.

Key code: `src/bun/repo-config.ts` (all I/O), `src/bun/rpc-handlers.ts` (3 new handlers + merge in `getProjects`, `activateTask`, `runCleanupScript`), `src/bun/cli-socket-server.ts` (CLI handlers).

## Risks

- **Settings drift**: A user saves to repo config, then later edits via the global "Save" button. The repo config still overrides. Source badges in the UI make this visible, but it could still confuse users initially.
- **File system permissions**: `.dev3/config.json` is read from `project.path` (main worktree), which should always be accessible. Worktrees share the same git content.

## Alternatives considered

- **Merge in data layer** (`loadProjects` returns merged data): Rejected because internal operations like `updateProject` would silently merge repo config into the saved data, causing drift.
- **Single file only** (no `config.local.json`): Rejected because machine-specific paths, secrets, or personal preferences need a git-ignored location.
