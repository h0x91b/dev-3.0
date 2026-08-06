# 002 — Global vs Project Settings for Agent Configuration

## Context

Agent configuration (which coding agent to use, which configuration) was stored per-project in `projects.json`. This caused issues: users had to set the agent for each project individually, and the project settings screen was cluttered with agent-related UI mixed with project-specific settings like setup script and base branch.

## Decision

Moved default agent and configuration to **global settings** stored in `~/.dev3.0/settings.json`. Project settings now only contain `setupScript` and `defaultBaseBranch`.

Key changes:
- New `src/bun/settings.ts` — `loadSettings()` / `saveSettings()` for global defaults
- `resolveCommandForProject()` in `agents.ts` reads from global settings instead of `project.defaultAgentId`
- `LaunchVariantsModal` receives `globalSettings` prop from `KanbanBoard`
- `GlobalSettings.tsx` gets a "Default Agent" section with agent + config dropdowns
- `ProjectSettings.tsx` stripped of all agent UI
- `Cmd+,` menu item opens global settings via `navigateToSettings` push message

The deprecated fields (`defaultTmuxCommand`, `defaultAgentId`, `defaultConfigId`) remain on the `Project` interface for JSON backward compatibility but are no longer read.

## Risks

- Existing projects with per-project agent overrides will lose those overrides. Since this is a solo/development tool, this is acceptable.
- The `settings.json` file is a single point of truth — no per-project agent override mechanism exists. If needed in the future, can be added back as an optional project-level override.

## Alternatives considered

- **Keep per-project + add global fallback**: More complex, two layers of resolution. Rejected because the solo-user nature of the tool doesn't warrant per-project agent variation.
- **Store in the same `projects.json`**: Would require a separate top-level key, messy structure. Dedicated file is cleaner.
