# Extra folders beside a project in the file explorer and on the dashboard

## Context

Agents often work across more than one folder: Claude Code reads `permissions.additionalDirectories` and touches a shared library or a sibling checkout beside the project. dev3 showed only the project checkout or task worktree, so half of what the agent worked on stayed invisible. VS Code solves the same problem with multi-root workspaces.

## Decision

`src/bun/project-folders.ts` (`resolveProjectFolders`) builds one list per project from three sources, deduped, without the project itself and without folders inside it:

- the new `extraFolders` config field (`src/shared/config-schema.ts`, `ui: "generic"`), absolute, `~/` or project-relative; per-machine paths go in `.dev3/config.local.json`;
- Claude's `additionalDirectories` from the project's `.claude/settings.json` and `settings.local.json`, plus the user-scope `settings.json` and `settings.local.json` in the config dir the project's agents launch with: the `CLAUDE_CONFIG_DIR` of the project's launch env (its own `env` plus the global agent env defaults, so the `{projectPath}/.claude` switch counts), else the server's, else `~/.claude`. The server's own `CLAUDE_CONFIG_DIR` is inherited from whatever shell started the app, so it counts only when the launch sets none; reading it first listed one project's grants on every project. A user-scope folder shows on every project that reads that dir. That is deliberate: Claude grants it to every session there, and seeing it is how a stale grant gets noticed. A folder inside the project is dropped, since its tree already shows it; a folder that contains the project stays, as the wider grant it is.
- the `folders` of every VS Code `*.code-workspace` file in the project root (JSONC; `path` entries and `file:` URIs). A Windows drive path is skipped on another OS, since a workspace file is often shared with Windows VS Code. A workspace folder is a view, not a grant: its `VS Code` tag keeps it apart from what Claude can read.

`getProjectFolders` returns the list; `listExplorerDirectory` takes an optional `folder` and accepts only a path in that list that exists, then applies the same outside-root check. In the renderer (`FileExplorer.tsx`) a project with folders switches to a multi-root tree: one sticky section per folder, the worktree or checkout first and open, extra folders collapsed. The header becomes a `Folders N/M` picker, because the task title beside it truncated to nothing at the default 260px. Until the folder list first answers, the header and tree show neither layout, so a multi-root project never flashes the single-root header. Which folders show is a per-project renderer preference (`src/mainview/project-folders.ts`, localStorage). The dashboard row gets a collapsed `+N folders` pill; expanded it lists three slim rows, then "Show N more", and a row opens the Repo screen with that folder revealed.

## Risks

Folders are project-scoped: they come from the main checkout's `.dev3` layers and `.claude/` settings, never a task worktree's, so a task explorer can list a folder its agent's worktree settings do not grant. The Worktree tab hides the field for that reason (`projectOnly` in the schema). A dev3 managed account's config dir is not followed: the folder list uses the launch env's pin, the server's `CLAUDE_CONFIG_DIR`, or `~/.claude`.

Three committed files can name folders: `.dev3/config.json`, `.claude/settings.json` and a `*.code-workspace` file. A cloned repo can therefore make dev3 list file names under a folder it chooses, to the local user. `extraFolders: []` in `.dev3/config.local.json` hides a committed list (`emptyArrayIsExplicit`). Two side effects are closed: network paths (`\\host\x`, `//host/x`) are dropped before any `stat`, because on Windows a `stat` alone sends the user's credentials to that host; and every git call in a listed folder runs with `safe.bareRepository=explicit` and `core.fsmonitor=false`, so a committed directory laid out as a bare repo cannot run a hook.

Each folder check resolves the config cascade, which can spawn git for compare-ref detection; `resolveProjectFolders` caches the result for 5 seconds so the 10-second explorer poll does not repeat it. The renderer reloads every shown list on window focus, one per dashboard card, so `getProjectFolders` answers from that cache too. Settings saves (`updateProjectSettings`, `saveRepoConfig`, `saveLocalConfig`, `dev3 config set|unset`) clear it, and the explorer's refresh button asks for a fresh read; a hand edit to a config or Claude settings file shows on the next focus once the 5 seconds pass. "Insert path" pastes an extra folder's absolute path, since the terminal runs in the worktree. A folder outside the project widens which file names reach that paste, so `quoteForShell` turns every control byte into an unquoted `?`: a name carrying `ESC[201~` would otherwise end bracketed paste and run the rest as typed input.

## Alternatives considered

A root switcher (one folder at a time) was cheaper but never shows the whole picture. A chip strip above the tree wraps and costs rows in a 260px panel. Reading Claude settings only would leave every other agent without the feature; a dev3 list only would duplicate what users already keep in `settings.local.json`.
