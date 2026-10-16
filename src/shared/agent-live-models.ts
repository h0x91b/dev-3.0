/**
 * Models an agent CLI reports at runtime for the selected account (omp today),
 * as opposed to the curated presets in DEFAULT_AGENTS.
 *
 * A pick is stored in the ordinary `configId` as `<presetId>|model=<selector>`,
 * so tasks, panes, resume, restart and scheduled launches carry it unchanged;
 * `findAgentConfig` turns it back into the preset with that model.
 */
import { MODEL_RELEASE_DATES } from "./model-release-dates";
import type { AgentConfiguration, CodingAgent } from "./types";

export interface LiveModel {
	/** What the CLI's `--model` takes, e.g. `openai-codex/gpt-6.1-sol`. */
	selector: string;
	provider: string;
	id: string;
	name: string;
}

export type AgentLiveModels = { status: "unknown" } | { status: "resolved"; models: LiveModel[] };

const LIVE_MODEL_MARKER = "|model=";

export function liveModelConfigId(presetId: string, selector: string): string {
	return `${presetId}${LIVE_MODEL_MARKER}${selector}`;
}

export function parseLiveModelConfigId(configId: string): { presetId: string; selector: string } | null {
	const at = configId.indexOf(LIVE_MODEL_MARKER);
	if (at <= 0) return null;
	const selector = configId.slice(at + LIVE_MODEL_MARKER.length);
	return selector ? { presetId: configId.slice(0, at), selector } : null;
}

/** Presets that leave the model to the CLI — the modes a live model is offered in. */
function modelFreePresets(agent: CodingAgent): AgentConfiguration[] {
	return agent.configurations.filter((config) => !config.model && !config.modelRoles);
}

function liveConfig(preset: AgentConfiguration, selector: string, label: string): AgentConfiguration {
	return {
		...preset,
		id: liveModelConfigId(preset.id, selector),
		name: `${label} · ${preset.name}`,
		model: selector,
		groupLabel: label,
		modeLabel: preset.modeLabel ?? preset.name,
	};
}

/** The configuration a `configId` names, live-model ids included; undefined
 *  when it names nothing (callers keep their own fallback). */
export function findAgentConfig(agent: CodingAgent, configId: string | null | undefined): AgentConfiguration | undefined {
	if (!configId) return undefined;
	const exact = agent.configurations.find((config) => config.id === configId);
	if (exact) return exact;
	const live = parseLiveModelConfigId(configId);
	if (!live) return undefined;
	const preset = agent.configurations.find((config) => config.id === live.presetId);
	if (!preset || preset.model || preset.modelRoles) return undefined;
	return liveConfig(preset, live.selector, live.selector.split("/").pop() || live.selector);
}

/** The agent with one picker group per live model, each offering every
 *  model-free preset as its modes. Order of `models` is kept. */
export function withLiveModelConfigs(agent: CodingAgent, models: readonly LiveModel[]): CodingAgent {
	const presets = modelFreePresets(agent);
	if (presets.length === 0 || models.length === 0) return agent;
	const nameCount = new Map<string, number>();
	for (const model of models) nameCount.set(model.name, (nameCount.get(model.name) ?? 0) + 1);
	const label = (model: LiveModel) => ((nameCount.get(model.name) ?? 0) > 1 ? `${model.name} · ${model.provider}` : model.name);
	const live = models.flatMap((model) => presets.map((preset) => liveConfig(preset, model.selector, label(model))));
	return { ...agent, configurations: [...agent.configurations, ...live] };
}

/** The agent with the live-model config `configId` names, when it is one the
 *  list does not hold (still loading, or another account's model), so the
 *  picker can still show what is selected. */
export function withSelectedLiveConfig(agent: CodingAgent, configId: string | null | undefined): CodingAgent {
	if (!configId || agent.configurations.some((config) => config.id === configId)) return agent;
	const config = parseLiveModelConfigId(configId) ? findAgentConfig(agent, configId) : undefined;
	return config ? { ...agent, configurations: [...agent.configurations, config] } : agent;
}

export function isLiveModelConfig(config: AgentConfiguration): boolean {
	return parseLiveModelConfigId(config.id) !== null;
}

function versionParts(id: string): number[] {
	const match = id.match(/\d+(?:[.-]\d+)*/);
	return match ? match[0].split(/[.-]/).map(Number) : [];
}

function compareVersionsDesc(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (b[i] ?? -1) - (a[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Newest first. Models group into families by their id up to the first digit
 *  (`gpt-`, `claude-opus-`); families order by the newest release date dev3
 *  knows for any member, models inside one by version number. A model dev3 has
 *  never heard of still lands on top of its family instead of at the bottom. */
export function sortLiveModelsNewestFirst(models: readonly LiveModel[]): LiveModel[] {
	const familyOf = (model: LiveModel) => model.id.replace(/\d.*$/, "");
	const familyDate = new Map<string, string>();
	for (const model of models) {
		const date = MODEL_RELEASE_DATES[model.id] ?? "";
		const family = familyOf(model);
		if (date > (familyDate.get(family) ?? "")) familyDate.set(family, date);
	}
	return [...models].sort((a, b) => {
		const byFamily = (familyDate.get(familyOf(b)) ?? "").localeCompare(familyDate.get(familyOf(a)) ?? "");
		if (byFamily !== 0) return byFamily;
		if (familyOf(a) !== familyOf(b)) return familyOf(a).localeCompare(familyOf(b));
		const byVersion = compareVersionsDesc(versionParts(a.id), versionParts(b.id));
		return byVersion !== 0 ? byVersion : a.name.localeCompare(b.name);
	});
}
