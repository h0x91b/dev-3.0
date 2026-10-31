# Global agent env defaults fill unset project env keys

## 1. Context
Agent sessions take env from the project (`.dev3/config.json`, `.dev3/config.local.json`, Project Settings) and from the agent config's `envVars`. A project that sets nothing inherits whatever the dev3 server process has. A user who pins each project's Claude login with `CLAUDE_CONFIG_DIR` in `.dev3/config.local.json` gets the server's login, which belongs to another project, in every newly added project until they write that file.

## 2. Investigation
No existing source covers "the same rule for every project". Project env is per project. Agent-config `envVars` is global, but its values are static and it overrides project env, the wrong precedence for a default. Managed accounts select one login for all projects.

## 3. Decision
`GlobalSettings.agentEnvDefaults` (Settings → Agents → Default agent environment) holds `KEY=value` defaults. `resolveProjectEnv` in `src/bun/repo-config.ts` fills each key the merged project env does not contain, after expanding `{home}`, `{projectPath}` and `{projectName}` (`src/shared/agent-env-defaults.ts`). A key the project sets, even to an empty string, keeps its value. Applying the defaults at the project-env layer, not as a separate layer at each spawn site, means every reader of the session env sees the same map: task, spawned, resumed, column and bug-hunter agents, the auto account router's pin check, Claude trust and config-dir provisioning, and the Repo terminal. The setup script gets them too: on launch it runs inside the agent session's env, so Re-run setup (`rerunSetupScript` in `src/bun/rpc-handlers/tmux-pty/setup-rerun.ts`) reads `resolveProjectEnv` as well, and both runs see one env. Dev and cleanup scripts read `resolveOperationalProjectConfig` and do not get the defaults. The placeholders use the project's main checkout path, not the worktree's, so a value that names a directory resolves to one place for all of a project's tasks.

## 4. Risks
A defaulted `CLAUDE_CONFIG_DIR` acts exactly like a project pin: dev3 provisions the directory and the auto account router stops routing that project. That is the purpose, but a user who sets it without logging in there gets a login prompt in each new project. Agent-config `envVars` and managed-account env still override the defaults, as they override project env. Values are stored in `settings.json` and written to the local log like other settings, so they are not a place for secrets. A config dir under `{projectPath}` lands inside the repository, where Claude writes its account state, history and transcripts into the working tree; the suggested example therefore uses `{home}`.

## 5. Alternatives considered
Writing a `.dev3/config.local.json` into each new project: dev3 would create files in user repos and touch `.gitignore`. A separate layer merged at each spawn site: about seven call sites, and the router and trust code would read a different env from the one the agent gets. Applying the defaults to scripts too: scripts already have their own env sources and gain nothing from an agent login setting.
