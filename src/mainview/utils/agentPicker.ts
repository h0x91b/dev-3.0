import type { AgentConfiguration, CodingAgent } from "../../shared/types";

/**
 * Presentation helpers for the Provider → Model → Mode launch picker.
 *
 * This is a **UI-only decomposition** of the flat preset list: it groups an
 * agent's `configurations` by model and derives a clean "mode" leaf label, so
 * the picker can cascade instead of showing one 21-row dropdown. The selected
 * leaf is still a plain `configId` — nothing here changes storage or command
 * resolution. See docs/ux/feature-plans/agent-picker-provider-model-mode.md.
 */

/** Clean 2nd-field ("Model") labels for the model strings shipped in
 *  DEFAULT_AGENTS. Keyed by the raw `config.model` value. Unknown models fall
 *  back to `prettifyModel`. Provider is already the 1st field, so labels omit
 *  the vendor prefix (e.g. "Opus 4.8", not "Claude Opus 4.8"). */
export const MODEL_GROUP_LABELS: Record<string, string> = {
	// Claude
	"claude-fable-5": "Fable 5",
	"claude-opus-4-8[1m]": "Opus 4.8",
	"claude-sonnet-5": "Sonnet 5",
	"claude-opus-4-7[1m]": "Opus 4.7",
	// Codex
	"gpt-5.6-sol": "GPT-5.6 Sol",
	"gpt-5.5": "GPT-5.5",
	"gpt-5.3-codex": "GPT-5.3 Codex",
	// Gemini
	"gemini-3.1-pro-preview": "Gemini 3.1 Pro",
	"gemini-3-flash-preview": "Gemini 3 Flash",
	"gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
	// Cursor Agent
	"opus-4.6-thinking": "Opus 4.6",
	"gpt-5.3-codex-high": "GPT-5.3 Codex",
	"gemini-3.1-pro": "Gemini 3.1 Pro",
	// OpenCode (namespaced)
	"anthropic/claude-opus-4-6": "Opus 4.6",
	"anthropic/claude-sonnet-4-6": "Sonnet 4.6",
	"anthropic/claude-haiku-4-5": "Haiku 4.5",
	"openai/gpt-5.5": "GPT-5.5",
	"openai/gpt-5.3-codex": "GPT-5.3 Codex",
	"opencode/big-pickle": "Big Pickle",
};

const PERMISSION_MODE_LABELS: Record<string, string> = {
	auto: "Auto",
	bypassPermissions: "Bypass",
	plan: "Plan",
	acceptEdits: "Accept Edits",
	dontAsk: "Don't Ask",
	default: "Default",
};

const EFFORT_LABELS: Record<string, string> = {
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "X-High",
};

/** Best-effort prettifier for a model string not in MODEL_GROUP_LABELS.
 *  Strips a `[duration]` suffix and a `vendor/` prefix, drops `-preview`/
 *  `-thinking`, and title-cases the remainder. Never throws. */
export function prettifyModel(model: string): string {
	const noDuration = model.replace(/\[[^\]]+\]/g, "");
	const scoped = noDuration.split("/").pop() ?? noDuration;
	const cleaned = scoped
		.replace(/-preview/gi, "")
		.replace(/-thinking/gi, "")
		.replace(/[-_]+/g, " ")
		.trim();
	if (!cleaned) return model;
	return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** The 2nd-field ("Model") group label for a single preset. */
export function getModelGroupLabel(config: AgentConfiguration): string {
	if (config.groupLabel) return config.groupLabel;
	if (config.model) return MODEL_GROUP_LABELS[config.model] ?? prettifyModel(config.model);
	return "Default";
}

/** Remove the group label from a preset name and tidy leftover punctuation,
 *  so a name like "GPT-5.5 Heavy Bypass" (group "GPT-5.5") reads "Heavy Bypass"
 *  and "Default (Fable 5)" (group "Fable 5") reads "Default". */
function stripGroupFromName(name: string, group: string): string {
	let out = name;
	if (group) out = out.split(group).join("");
	out = out
		.replace(/\(\s*[,;]?\s*\)/g, "") // empty "()" / "( , )"
		.replace(/\(\s*[,;]\s*/g, "(") // "( , X" -> "(X"
		.replace(/\s*[,;]\s*\)/g, ")") // "X , )" -> "X)"
		.replace(/\(\s+/g, "(")
		.replace(/\s+\)/g, ")")
		.replace(/\s{2,}/g, " ")
		.replace(/^[\s·,;/-]+|[\s·,;/-]+$/g, "")
		.trim();
	return out;
}

/** The 3rd-field ("Mode") leaf label for a single preset.
 *  Prefers an explicit `modeLabel`, then a label built from the structured
 *  `permissionMode`+`effort` fields (Claude/Gemini/Cursor), then the preset
 *  name with its model stripped (Codex/OpenCode, which encode mode in args). */
export function getModeLeafLabel(config: AgentConfiguration): string {
	if (config.modeLabel) return config.modeLabel;
	if (config.permissionMode || config.effort) {
		const mode = PERMISSION_MODE_LABELS[config.permissionMode ?? "default"] ?? config.permissionMode ?? "Default";
		const effort = config.effort ? (EFFORT_LABELS[config.effort] ?? config.effort) : "";
		return effort ? `${mode} · ${effort}` : mode;
	}
	const stripped = stripGroupFromName(config.name, getModelGroupLabel(config));
	return stripped || config.name;
}

export interface PickerGroup {
	/** The 2nd-field label. */
	label: string;
	/** Presets in this model group, in their declared order. */
	configs: AgentConfiguration[];
}

/** Group an agent's configurations by model into ordered picker groups.
 *  First-seen order is preserved for both groups and configs within a group,
 *  so the curated DEFAULT_AGENTS ordering carries through. */
export function buildPickerGroups(agent: CodingAgent | undefined | null): PickerGroup[] {
	if (!agent) return [];
	const order: string[] = [];
	const byLabel = new Map<string, AgentConfiguration[]>();
	for (const config of agent.configurations) {
		const label = getModelGroupLabel(config);
		let bucket = byLabel.get(label);
		if (!bucket) {
			bucket = [];
			byLabel.set(label, bucket);
			order.push(label);
		}
		bucket.push(config);
	}
	return order.map((label) => ({ label, configs: byLabel.get(label) as AgentConfiguration[] }));
}

/** True when a Model group is entirely gated behind the pxpipe token-saving
 *  proxy (every preset in it sets `requiresPxpipeProxy`). The "Fable 5 (cost
 *  trick)" group is the only such group today — used to disable its Model
 *  option until the proxy is enabled in Settings. */
export function groupRequiresPxpipeProxy(group: PickerGroup): boolean {
	return group.configs.length > 0 && group.configs.every((c) => c.requiresPxpipeProxy === true);
}

/** The group label that owns a given configId (for decomposing a stored
 *  selection back into the cascade's 2nd field). Null when not found. */
export function groupLabelForConfig(agent: CodingAgent | undefined | null, configId: string | null | undefined): string | null {
	if (!agent || !configId) return null;
	const config = agent.configurations.find((c) => c.id === configId);
	return config ? getModelGroupLabel(config) : null;
}

/** Signature used to preserve the "kind" of mode across a model change. */
function modeSignature(config: AgentConfiguration): string {
	return `${config.permissionMode ?? "default"}|${config.effort ?? ""}`;
}

/**
 * When the user changes the Model field, choose which preset in the new group
 * to select. Preserves the current mode *kind* (lazy-human, bible §1.0):
 *   1. exact permissionMode+effort signature,
 *   2. same permissionMode (effort differs — e.g. Fable 5 has no effort tiers),
 *   3. same derived leaf label (for arg-encoded agents with no structured fields),
 *   4. the group's first preset.
 * Returns null only when the group is empty.
 */
export function pickConfigForModelChange(
	group: PickerGroup,
	previous: AgentConfiguration | null | undefined,
): AgentConfiguration | null {
	if (group.configs.length === 0) return null;
	if (!previous) return group.configs[0];

	const prevSig = modeSignature(previous);
	const exact = group.configs.find((c) => modeSignature(c) === prevSig);
	if (exact) return exact;

	const prevMode = previous.permissionMode ?? "default";
	const sameMode = group.configs.find((c) => (c.permissionMode ?? "default") === prevMode);
	if (sameMode) return sameMode;

	const prevLeaf = getModeLeafLabel(previous);
	const sameLeaf = group.configs.find((c) => getModeLeafLabel(c) === prevLeaf);
	if (sameLeaf) return sameLeaf;

	return group.configs[0];
}
