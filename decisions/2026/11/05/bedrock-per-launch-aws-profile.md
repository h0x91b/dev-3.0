# Per-launch AWS profile for Bedrock agents

## Context

Picking an AWS account for a Bedrock launch needed one dev3 agent per account, each a copy of every preset with `AWS_PROFILE`/`AWS_REGION` in its `envVars`. Six accounts already meant six agents times thirteen presets in the launch dialog. The managed-account mechanism (Agent accounts / API profiles) was not an option: a managed Claude account sets `CLAUDE_CONFIG_DIR` to its own folder, which overrides a project that keeps its own `<project>/.claude`.

## Decision

`ProviderSettings.profiles` (`src/shared/types/model-routing.ts`) lists named entries `{ name, awsProfile, region? }` plus an optional `defaultProfile`, for providers whose registry entry sets `usesAwsProfiles` (both Bedrock backends). A launch carries `LaunchVariant.bedrockProfile` (undefined = the agent default, null = none, a name = that entry). `applyBedrockProfileEnv` (`src/bun/agents.ts`) applies the entry after the preset `envVars`, so a picked profile beats both the preset and the project's `.dev3/config.local.json` env (projects merge under the agent env). None injects nothing, and the project env decides.

The resolved name is stored on the task and on every `PaneSessionEntry`. Resume, Retry, Spawn and column agents read it from there, so a session never moves to a changed agent default. The last explicit pick is remembered per project in `~/.dev3.0/preferences.json` (`bedrockProfileByProject`). The dialog seeds from it, then from the agent default. A column agent with no pick of its own follows the task's pick.

## Risks

A profile renamed or removed after launch injects nothing on the next launch, so the project env decides, and a toast (`kanban.launchAwsProfileMissing`) tells the user. The task and pane keep the name, so restoring it in Settings switches the task back. Persisting null instead would pin the task to the project env's account for good. `dev3 agent aws-profiles set` lets any CLI caller, an agent included, rewrite the list.

## Alternatives considered

Managed accounts: rejected because of `CLAUDE_CONFIG_DIR`, see Context. Storing the resolved `AWS_PROFILE`/`AWS_REGION` values on the pane instead of the entry name: more robust to edits, but a fixed typo in the list would never reach a running task. Remembering the pick in renderer `localStorage`: a browser in remote mode would not share it with the desktop.
