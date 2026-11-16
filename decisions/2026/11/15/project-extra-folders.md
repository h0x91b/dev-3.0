# Extra folders beside a project in the file explorer and on the dashboard

## Context

Agents often work across more than one folder: Claude Code reads `permissions.additionalDirectories` and touches a shared library or a sibling checkout beside the project. dev3 showed only the project checkout or task worktree, so half of what the agent worked on stayed invisible. VS Code solves the same problem with multi-root workspaces.

## Decision

`src/bun/project-folders.ts` (`resolveProjectFolders`) builds one list per project from two sources, deduped and without the project itself:

- the new `extraFolders` config field (`src/shared/config-schema.ts`, `ui: "generic"`), absolute, `~/` or project-relative; per-machine paths go in `.dev3/config.local.json`;
- Claude's `additionalDirectories` from the project's `.claude/settings.json` and `settings.local.json`, plus the config dir the project pins through `env.CLAUDE_CONFIG_DIR`. The user-wide `~/.claude` is not read: it would put the same folders on every project.

`getProjectFolders` returns the list; `listExplorerDirectory` takes an optional `folder` and accepts only a path in that list that exists, then applies the same outside-root check. In the renderer (`FileExplorer.tsx`) a project with folders switches to a multi-root tree: one sticky section per folder, the worktree or checkout first and open, extra folders collapsed. The header becomes a `Folders N/M` picker, because the task title beside it truncated to nothing at the default 260px. Which folders show is a per-project renderer preference (`src/mainview/project-folders.ts`, localStorage). The dashboard row gets a collapsed `+N folders` pill; expanded it lists three slim rows, then "Show N more", and a row opens the Repo screen with that folder revealed.

## Risks

A committed `.dev3/config.json` can name any local folder, so opening a cloned repo lists that folder's file names in the explorer. Nothing is executed or sent anywhere, and the same repo could already ask the agent to read it. "Insert path" pastes an extra folder's absolute path, since the terminal runs in the worktree. Each `getProjectFolders` reads up to four small JSON files; the renderer shares one fetch per project.

## Alternatives considered

A root switcher (one folder at a time) was cheaper but never shows the whole picture. A chip strip above the tree wraps and costs rows in a 260px panel. Reading Claude settings only would leave every other agent without the feature; a dev3 list only would duplicate what users already keep in `settings.local.json`.
