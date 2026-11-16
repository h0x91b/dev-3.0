# Extra folders beside a project in the file explorer and on the dashboard

## Context

Agents often work across more than one folder: Claude Code reads `permissions.additionalDirectories` and touches a shared library or a sibling checkout beside the project. dev3 showed only the project checkout or task worktree, so half of what the agent worked on stayed invisible. VS Code solves the same problem with multi-root workspaces.

## Decision

`src/bun/project-folders.ts` (`resolveProjectFolders`) builds one list per project from two sources, deduped and without the project itself:

- the new `extraFolders` config field (`src/shared/config-schema.ts`, `ui: "generic"`), absolute, `~/` or project-relative; per-machine paths go in `.dev3/config.local.json`;
- Claude's `additionalDirectories` from the project's `.claude/settings.json` and `settings.local.json`, plus the config dir the project pins through `env.CLAUDE_CONFIG_DIR`. The user-wide `~/.claude` is not read: it would put the same folders on every project.

`getProjectFolders` returns the list; `listExplorerDirectory` takes an optional `folder` and accepts only a path in that list that exists, then applies the same outside-root check. In the renderer (`FileExplorer.tsx`) a project with folders switches to a multi-root tree: one sticky section per folder, the worktree or checkout first and open, extra folders collapsed. The header becomes a `Folders N/M` picker, because the task title beside it truncated to nothing at the default 260px. Which folders show is a per-project renderer preference (`src/mainview/project-folders.ts`, localStorage). The dashboard row gets a collapsed `+N folders` pill; expanded it lists three slim rows, then "Show N more", and a row opens the Repo screen with that folder revealed.

## Risks

Folders are project-scoped: they come from the main checkout's `.dev3` layers and `.claude/` settings, never a task worktree's, so a task explorer can list a folder its agent's worktree settings do not grant. The Worktree tab hides the field for that reason (`projectOnly` in the schema). Only the config dir pinned in the project's own `env` is read, not one set through global agent defaults.

Two committed files can name folders: `.dev3/config.json` and `.claude/settings.json`. A cloned repo can therefore make dev3 list file names under a folder it chooses, to the local user. `extraFolders: []` in `.dev3/config.local.json` hides a committed list (`emptyArrayIsExplicit`). Two side effects are closed: network paths (`\\host\x`, `//host/x`) are dropped before any `stat`, because on Windows a `stat` alone sends the user's credentials to that host; and every git call in a listed folder runs with `safe.bareRepository=explicit` and `core.fsmonitor=false`, so a committed directory laid out as a bare repo cannot run a hook.

Each folder check resolves the config cascade, which can spawn git for compare-ref detection; `resolveProjectFolders` caches the result for 5 seconds so the 10-second explorer poll does not repeat it. "Insert path" pastes an extra folder's absolute path, since the terminal runs in the worktree.

## Alternatives considered

A root switcher (one folder at a time) was cheaper but never shows the whole picture. A chip strip above the tree wraps and costs rows in a 260px panel. Reading Claude settings only would leave every other agent without the feature; a dev3 list only would duplicate what users already keep in `settings.local.json`.
