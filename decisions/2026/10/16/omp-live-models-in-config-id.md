# omp's live models ride the configId as `<preset>|model=<selector>`

> Partly superseded on 2026-10-17 by `decisions/2026/10/17/pi-managed-accounts-share-the-agent-dir-engine.md`: `src/bun/omp-live-models.ts` is now `src/bun/agent-dir-live-models.ts` (`getAgentDirLiveModels`), serving pi as well.

## Context

omp reaches 60+ providers, so its presets pin no model and omp picks its own startup model — for an install with API keys in the environment that was `cerebras/zai-glm-4.7`, because omp takes the first provider default it finds (`pickDefaultAvailableModel`, can1357/oh-my-pi @a536558) and the openai-codex default (`gpt-5.5`) is no longer in that provider's catalog. Users need the models their account actually has, in the launch picker.

## Investigation

`LaunchVariant`, `Task`, pane session state, scheduled launches, resume, restart and the CLI spawn path all carry only `agentId/configId/accountId`. A separate model field would have to thread through every one of them. `omp models --json` lists every provider omp can reach, including env API keys; `omp usage accounts --json` lists only the account's OAuth sign-ins. Both are token-free.

## Decision

- `src/bun/omp-live-models.ts` lists chat models of the account's signed-in providers, in the agent dir a launch on that account would use, newest first (`sortLiveModelsNewestFirst`: families by dev3's newest known release date, versions inside a family).
- The `getAgentLiveModels` RPC serves them to `useLiveModels`.
- `AgentConfigPicker` expands each model over the agent's model-free presets (`withLiveModelConfigs`), so the existing Model → Mode cascade renders them unchanged.
- A pick is an ordinary configId, `liveModelConfigId(preset, selector)`. `findAgentConfig` in `src/shared/agent-live-models.ts` resolves it everywhere a configId is looked up: the bun `findConfig`, CLI spawn validation, and the renderer's card, popover and analytics.
- A pick the newly chosen account does not serve falls back to its preset alone.

## Risks

- A stored pick outlives the model. A launch then gets an unknown `--model`, and omp reports that itself. The picker shows the pick by its id until the list loads.
- Env-key providers are deliberately absent from the list. Using one still works through omp's own `/model` or a custom preset.

## Alternatives considered

- **A `model` field on `LaunchVariant`/`Task`/panes:** the same result, through a dozen RPCs and persistence paths.
- **Saving each picked model as a real preset in agents.json:** fills Settings with one preset per model × mode.
- **Hard-coded Codex presets as for Copilot:** wrong for every other provider, and stale with every omp release.

## Addendum — newest model by default

On a launch surface (the picker has `onAccountChange`) a model-free preset is swapped for the account's newest live model under the same preset, until the user picks a model by hand; Settings surfaces never rewrite the stored preset. Model switches keep the same underlying preset (`pickConfigForModelChange`), because omp's modes differ only in `--thinking` args the mode signature cannot see.

Addendum 2026-10-17: the auto-pick passes `--model`, which overrides omp's own `modelRoles.default`. So `getOmpLiveModels` also reads `omp config get modelRoles --json` in the account's dir and moves that model to the front of the list when the account can reach it; the preselect then matches what a bare `omp` would start on. An unreadable or unreachable default leaves the newest-first order.
