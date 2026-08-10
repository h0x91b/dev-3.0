# Project Settings saves go into the config layer that wins the cascade

## Context

`resolveProjectConfig` ranks `.dev3/config.local.json` > `.dev3/config.json` > the `Project`
object in `projects.json` > `DEFAULTS`. The Project Settings tab always saved through
`updateProjectSettings`, which writes the `Project` object — the lowest file-independent layer.
For any field a `.dev3` file already declared, the save looked successful (the handler echoed the
raw record back and the UI dispatched it) and then reverted on the next `getProjects`, which
resolves the cascade. This repo's own `.dev3/config.json` pinned `builtinColumnAgents`, so the AI
Review preset was unchangeable from the UI.

## Investigation

`src/bun/rpc-handlers/app-handlers.ts:164` resolves every project on read, while
`updateProjectSettings` returned the unresolved record — the only reason the change appeared to
stick until a reload. Separately, `findConfig` (`src/bun/agents.ts`) fell back to
`configurations[0]` for an unknown preset id, so the long-dead `claude-bypass-sonnet` stored in
every project silently launched the first preset in the list rather than a Sonnet one.

## Decision

`repoConfig.saveConfigToWinningLayer` (`src/bun/repo-config.ts`) routes each incoming key to the
highest `.dev3` layer that already defines it and returns the rest for `projects.json`;
`updateProjectSettings` uses it and returns the resolved project. `env` is excluded — it merges per
key (decision 179) and may hold personal secrets that must not land in a committed file. Unknown
preset ids now route through `DEPRECATED_DEFAULT_CONFIG_REMAP` before falling back to the agent's
`defaultConfigId`, and `remapColumnAgents` (`src/shared/types.ts`) rewrites stored column agents on
both read paths.

## Risks

Saving from the Project tab can now modify a git-tracked `.dev3/config.json`, which shows up as a
working-tree change. That is the intended trade: the alternative is a save that provably does
nothing. No file is ever created by this path — only keys already present in an existing file are
redirected.

## Alternatives considered

Dropping `builtinColumnAgents` from `DEV3_REPO_CONFIG_KEYS` would fix the AI Review case alone and
break sharing the review preset through the repo, leaving every other field equally broken.
Disabling the inputs when a file override exists is honest but leaves the user editing JSON by hand
for a setting the UI already renders.
