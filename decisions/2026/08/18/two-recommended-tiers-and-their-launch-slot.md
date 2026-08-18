# Two recommended tiers, and the slot each one launches on

## Context

The curated set dev3 seeds after connecting a provider was a single preset ("Best value") holding one model per agent role. One preset cannot express the thing routing is for: the model doing an ordinary turn and the model you escalate to are different models, and a user who wants "cheap by default, smart when it matters" had to hand-edit roles to get it.

## Investigation

Two facts decided the shape, and both were measured rather than assumed.

1. **The launcher's Model column groups by `groupLabel`** (`buildPickerGroups` in `src/mainview/utils/agentPicker.ts`). Two tiers sharing a label collapse into one Model row whose two Modes are indistinguishable — both are cloned from the same base preset, so their mode labels are identical. Tiers therefore need distinct labels, not distinct names under one label.
2. **A seeded preset used to launch on the most expensive slot it had.** `seedPresetForAgent` deliberately stripped the clone's `model`, and `claudeLaunchSlot` then fell back to the first bound role in *display* order — `fable`. Verified by running the pure functions over a freshly seeded preset: `--model` came out as the fable binding while the opus binding sat unused. Every routed session was billed at premium rates for ordinary work.

Model choice also turned on a capability the catalog exposes and we were not reading: **image input**. `qwen/qwen3.8-2.4t-a95b` (open weights) reports no image modality; `qwen/qwen3.8-max` does, at the same published price. Kimi K3 was picked for the premium slot because it sees images, not because it benchmarks higher.

## Decision

`RECOMMENDED_TIERS` in `src/shared/recommended-models.ts` declares two tiers, each a whole raster over both CLIs' roles (`claude` and `codex` maps, declared separately — Claude has four slots, Codex three and no premium slot):

- **practical** (`"Best value"`) — Qwen3.8 Max / GLM 5.2 / DS Flash / DS Flash, launching on `opus`.
- **smart** (`"Best value · Smart"`) — Kimi K3 / GLM 5.2 / GLM 5.2 / DS Flash, launching on `fable`.

`launchSlot` reaches the launch as the preset's own `model` (`tierLaunchModel` → `CLAUDE_ROLE_BUILTIN_MODEL[slot]`), which `resolveModelRoleLaunch` turns into that slot's wire name. Independently, `CLAUDE_LAUNCH_FALLBACK` in `model-catalog.ts` now falls back `opus → sonnet → fable → haiku`, so a hand-built preset that names no model also opens on the workhorse.

Identity moved from the group label to `AgentConfiguration.seededTier`; `tierOfPreset` reads a preset that has no `seededTier` but carries the old label as the practical tier — that is exactly the raster it had. `pendingPresetUpdates` can now propose a whole new preset (`newPreset`), because a revision that introduces a tier must be able to hand it to a user who connected long ago, and `markRevisionSeen` stamps every seeded preset of the agents it spoke about — stamping only the listed config ids would leave the declined offer coming back forever.

## Risks

`seededTier` is new on-disk state. An older installed version ignores the field and sees two presets it did not create; both are valid presets, so nothing breaks. The practical tier keeps the exact string `"Best value"` so no rename touches existing data.

Two seeded presets per agent means the Model dropdown grows by one row per routable agent. If more tiers ever land, that column needs a real submenu rather than one row each.

## Alternatives considered

- **Three tiers (cheap / balanced / smartest).** Rejected by the user after the numbers: with `opus` and the fast slots equal across tiers, the middle tier was indistinguishable from its neighbours in everyday work.
- **Tiers differing only in the premium slot.** Rejected: Claude Code works on `opus`/`sonnet`, and Codex has no premium slot at all, so all tiers would have behaved identically in Codex.
- **Changing the fallback order alone, with no per-tier launch model.** Rejected: it would leave no way for the smart tier to open on its premium model, which is the reason someone picks it.
