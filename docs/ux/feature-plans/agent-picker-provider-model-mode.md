# Feature plan — Agent picker: Provider → Model → Mode (3-field cascade)

Status: `Observed` (implemented — Candidate B chosen; user signed off on UI-only grouping + code-now)
Owner: UX Architecture
Source: `/ux-principal` run, task "Redesign agent picker" (evaluates the flat-preset ballooning found in the Claude preset overhaul, task c29366db)

## 1. Problem

The Launch Task / add-variant picker (`LaunchVariantsModal`) is a flat **2-field** control per variant row: **Agent** (`CodingAgent`) + **Configuration** (one `Select` over `agent.configurations`). Each `AgentConfiguration` is a flat preset whose `name` bakes three orthogonal dimensions into one string — e.g. `Bypass (Opus 4.8, X-High)` = permission mode × model × effort.

Claude alone now has **21** presets in that one dropdown (Auto/Bypass × {Fable 5, Opus 4.8, Sonnet 5, Opus 4.7} × {Medium, X-High} + Default/Plan/Accept-Edits tiers). Verified in-app: the dropdown is a scrolling 21-row list (screenshot in task). It only grows as models are added, and the compact label helper (`getCompactConfigLabel`, `utils/taskAgentMeta.ts`) already reverse-parses these names by regex to re-split them for the cards/sidebar — a fragility signal that the flattening is fighting the data.

## 2. Feature classification

- **User job:** at launch (and add-variant / add-attempt), choose which agent + configuration each variant runs.
- **Feature class:** `configuration` selection *inside* a `primary_action` flow (Launch). NOT durable config (that is `AgentSettingsSection`).
- **Owning surface:** `Modal` (`LaunchVariantsModal`). Mirrored authoring surface: Settings → Agents (`AgentSettingsSection`, whose `ConfigEditor` already edits `model`/`permissionMode`/`effort` as separate fields).
- **Scope:** per-variant, per-launch. **Frequency:** constant. **Risk:** safe (selection only), but it drives cost/behavior — clarity is the whole point.

## 3. Placement decision

**Keep it in `LaunchVariantsModal`, same per-variant-row model. No new surface, nav item, toolbar, or destination.** This is a within-modal refinement of an existing control cluster → **zero** impact on the ≤7 nav budget and no toolbar-button-creep (the project's #1 anti-pattern). Rejected: promoting agent choice to a board/header control (it is per-task, not global); a separate "configure launch" screen (over-engineering a modal field).

The row grows from 2 selects to **3 cascading selects**: **Provider → Model → Mode**. `+ Add Variant`, Watch, Cancel, Launch, and the analytics call sites are unchanged.

## 4. THE data-model fork (the real decision)

Three viable approaches. The providers' matrices are **irregular and curated**, which is decisive:

- Claude: model × mode, but effort exists only for Opus 4.8 / Sonnet 5 and only under Auto/Bypass; Opus 4.7 has only Auto/Bypass; presets carry `additionalArgs`, `envVars`.
- Codex: 2nd axis = model (GPT-5.5 / 5.3), 3rd axis = **effort × sandbox** encoded entirely in `additionalArgs` (`model_reasoning_effort`, `--sandbox danger-full-access`, `default_permissions`) + a Plan preset with a plan-forcing `appendPrompt`. No `permissionMode`/`effort` fields at all.
- Gemini/Cursor: model × mode, irregular per tier/model.
- OpenCode: 2nd axis = **persona/role** (Sisyphus/Prometheus/Atlas/Hephaestus), model is the 3rd axis — does not fit "Model → Mode" at all.

### Candidate A — Decompose the data model into orthogonal model/mode entities (rejected)

Store `{model, mode, effort}` triples; compose the command at launch. **Rejected:** the matrices are not a clean cross-product, so this (a) generates invalid/nonsensical combos, (b) loses per-preset curation (`appendPrompt`, `additionalArgs`, `envVars`, `baseCommandOverride`, sandbox), and (c) forces a real migration of `Task.configId` + `GlobalSettings.defaultConfigId` (persisted in `tasks.json` per task, with an existing `DEPRECATED_*_REMAP` apparatus) across app versions that share `~/.dev3.0/`. High risk, low payoff.

### Candidate B — UI-only decomposition, flat `configId` stays the durable key (CHOSEN)

The 3 fields are a **presentation cascade over the existing flat preset list**; the selected leaf still resolves to one `configId`, which stays the storage + command-resolution unit. **No storage migration, no command-resolution change, curation preserved, irregular matrices handled for free** ("show only the presets that exist for this provider+model").

- **Grouping (2nd field):** group each provider's configs by their existing `config.model` string; label via the existing `getFallbackModelLabel(model)`. This is data we already have and is 100% reliable (no name-parsing).
- **Leaf (3rd field, "Mode"):** the presets remaining after (provider, model) are fixed; label each by its mode/effort. Derive from `config.name` minus the model, reusing the `getCompactConfigLabel` logic.
- **Two OPTIONAL presentation fields on `AgentConfiguration`** for the cases where model-grouping is wrong or the derived label is ugly:
  - `groupLabel?: string` — override the 2nd-field group (needed for OpenCode role-grouping; e.g. `"Sisyphus (Orchestrator)"`).
  - `modeLabel?: string` — clean 3rd-field label (e.g. `"Heavy · Bypass"`, `"Sonnet 4.6"`).
  Both optional → legacy/user-created presets fall back to model-group + parsed name. Set only in curated `DEFAULT_AGENTS`. **This is additive, backward-compatible, and touches no persisted user state.**

### Candidate C — Keep 2 fields, add optgroup headers to the Configuration dropdown (fallback)

Lighter: one dropdown, but grouped by model subheaders. Requires enhancing `Select` (no optgroup today) and still shows one long (21-row) list — grouping aids scanning but does not *reduce the choice at each step*. The cascade's real win is 4-then-≤7 vs 21-at-once. Keep as the low-effort fallback if the 3-select row proves too dense.

## 5. Cascade interaction

- **Field 1 Provider** (`CodingAgent`): existing agent `Select` (keeps the "Not Installed" badge via `useAgentRenderOption`).
- **Field 2 Model/Group**: options = distinct `groupLabel ?? getFallbackModelLabel(config.model)` for the provider's configs, in first-seen order.
- **Field 3 Mode**: options = the configs matching (provider, selected group), labeled by `modeLabel ?? <name minus model>`; `value = configId`.
- **Axis labels are per-provider** (default `Model` / `Mode`; OpenCode → `Role` / `Model`). A provider declares its two sub-axis labels once (small addition to `CodingAgent`, or inferred). Avoids mislabeling OpenCode/Codex.
- **Change propagation (lazy-human, bible §1.0):**
  - Change Provider → reset Model to the provider's default config's group; Mode to that default.
  - Change Model → **preserve the current Mode *kind* if it exists** in the new group (e.g. `Bypass · X-High` carried Opus 4.8 → Sonnet 5); else fall back to the new group's default/first preset. This keeps intent across a model swap with zero extra clicks.
- **Open state:** decompose the incoming `{agentId, configId}` (global default, or the row's current value) back into the 3 fields.

## 6. Empty / single / irregular states

- **Single-preset group** (e.g. Claude + Opus 4.7 → 2 modes; a group with exactly 1): the Mode `Select` still renders with its one option (keeps layout stable — no field that appears/disappears). Auto-selected.
- **Provider with configs that have no `model`** (fully custom): they collapse under one group (`groupLabel` or `"Default"`), Mode lists them — i.e. gracefully degrades to today's flat list under one group. Never an empty Mode field.
- **Removed/renamed preset** referenced by an existing task: unchanged — `findConfig` + `DEPRECATED_DEFAULT_CONFIG_REMAP` still resolve it; the picker just shows the resolved leaf.

## 7. Complexity budget & responsive

- Desktop: 3 selects + variant number + remove button in a `max-w-xl` modal row. Tight but acceptable for an expert flow; the Mode label is usually short. If it reads cramped, the Mode field can become a segmented control when its option count ≤4 (enhancement, not required).
- **Narrow (<768, bible §12.3):** the modal is a full-bleed sheet and the 3 selects **stack vertically** within each variant row (they must not sit in a non-wrapping horizontal row — anti-pattern §11). Labels stay above each select.

## 8. Token roles

All three fields: the existing `Select` (neutral form control — `bg-elevated` + `border-edge`, `border-accent` when open). Launch = `primary` (`bg-accent`). Remove-variant = destructive-ghost icon. Watch toggle unchanged. **No new tokens.**

## 9. Accessibility

- Each `Select` gets a `<label htmlFor>` + `id` (existing pattern) with per-provider axis text.
- On Model change → Mode reset, keep focus on the Model trigger (don't yank focus); `aria-live` optional to announce the new Mode.
- **Known pre-existing gap (out of scope, note it):** the custom `Select` has no in-dropdown Arrow-key navigation (only Tab between selects + mouse). The cascade inherits this; fixing it is a separate `Select` improvement.

## 10. AgentSettingsSection impact

Minimal. `ConfigEditor` already edits `model`/`permissionMode`/`effort` separately. Add optional inputs for `groupLabel`/`modeLabel` (curated presets only; custom presets derive). Optionally group the settings config *list* by model for visual parity — **follow-up, not required**.

## 11. Migration

**None.** `configId` remains the durable key in `tasks.json`, `agents.json`, and `GlobalSettings`. New fields are optional and presentation-only. Honors the frozen `~/.dev3.0/` layout invariants (configId is not a path; no rename/move/delete of on-disk state).

## 12. Scope / non-goals

- In: `LaunchVariantsModal` 3-field cascade + decompose/recompose helpers (`utils/taskAgentMeta.ts` or a new `utils/agentPicker.ts`), optional `groupLabel`/`modeLabel` on `AgentConfiguration`, per-provider axis labels on `CodingAgent`, `DEFAULT_AGENTS` annotations, i18n `launch.provider`/`launch.model`/`launch.mode`, tests, changelog, tip (optional).
- Out: data-model decomposition (Candidate A), `Select` arrow-key nav, grouping the settings list, segmented-control Mode field.

## 13. Files likely to change

`src/mainview/components/LaunchVariantsModal.tsx`, `src/mainview/utils/taskAgentMeta.ts` (or new `utils/agentPicker.ts` for group/leaf derivation), `src/shared/types.ts` (`AgentConfiguration.groupLabel?`/`modeLabel?`, `CodingAgent` axis labels, `DEFAULT_AGENTS` annotations), i18n `en/ru/es` (`launch.*`), `__tests__/LaunchVariantsModal.test.tsx` + a pure-helper test, `AgentSettingsSection.tsx` (optional label inputs), changelog entry.
