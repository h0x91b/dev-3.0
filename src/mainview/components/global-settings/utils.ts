import type {
	AgentConfiguration,
	AgentFamily,
	ExternalApp,
	GlobalSettings,
	LlmProvider,
	ProviderConfig,
} from "../../../shared/types";
import { agentKey } from "../../../shared/agent-adapters/families";
import { hasOmpFlag, OMP_APPROVAL_MODE } from "../../../shared/agent-adapters/omp-flags";
import { buildProviderEnv, getProviderDefinition, providerPinnedModel } from "../../../shared/llm-provider";
import { ENV_UNSET } from "../../../shared/agent-accounts";
import { type ModelCatalog, resolveModelRoleLaunch, roleUnsetEnv } from "../../../shared/model-catalog";

/** The proxy's port and session key are decided when it starts, so the preview
 *  shows their shape rather than inventing values it cannot know. */
const PREVIEW_RUNTIME = { baseUrl: "http://127.0.0.1:PORT", sessionKey: "sk-bf-…" };

export type Theme = "dark" | "light" | "system";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto",
	taskSortOrder: "oldest-first",
	updateChannel: "stable",
};

export function resolveTheme(
	theme: Theme,
	prefersDark: boolean,
): "dark" | "light" {
	if (theme === "system") {
		return prefersDark ? "dark" : "light";
	}
	return theme;
}

export function toStoredTaskOpenMode(
	mode: "split" | "fullscreen",
): GlobalSettings["taskOpenMode"] {
	return mode === "fullscreen" ? "fullscreen" : undefined;
}

export type DiffViewModePreference = "split" | "unified" | "auto";

export function toStoredDiffViewMode(
	mode: DiffViewModePreference,
): GlobalSettings["defaultDiffViewMode"] {
	return mode;
}

/**
 * Threshold in CSS pixels separating "laptop" screens from external monitors.
 * MacBook 13–16" Retina report 1280–1728 CSS px wide; external 24"+ monitors
 * usually 1920+. 1800 sits in the gap with margin on both sides.
 */
export const AUTO_DIFF_VIEW_WIDTH_THRESHOLD = 1800;

/**
 * Resolves the "auto" diff view preference to a concrete mode based on the
 * screen width in CSS pixels. WebKit does not expose physical inches, so this
 * is the best proxy we have: narrow screen → laptop → unified is more readable.
 */
export function resolveAutoDiffViewMode(
	screenWidthCssPx: number,
): "split" | "unified" {
	return screenWidthCssPx < AUTO_DIFF_VIEW_WIDTH_THRESHOLD ? "unified" : "split";
}

/**
 * Resolves a stored preference (which may be undefined or "auto") into a
 * concrete diff view mode. `undefined` is treated as "auto" — that is the new
 * default for users who have never touched the setting.
 */
export function resolveDiffViewMode(
	preference: GlobalSettings["defaultDiffViewMode"],
	screenWidthCssPx: number,
): "split" | "unified" {
	if (preference === "split" || preference === "unified") {
		return preference;
	}
	return resolveAutoDiffViewMode(screenWidthCssPx);
}

export type DropSide = "before" | "after";

export function reorderToTarget<T>(
	items: T[],
	sourceId: string,
	targetId: string,
	side: DropSide,
	getId: (item: T) => string,
): T[] {
	if (sourceId === targetId) return items;
	const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
	if (sourceIndex === -1) return items;
	const without = items.slice();
	const [moved] = without.splice(sourceIndex, 1);
	const targetIndex = without.findIndex((item) => getId(item) === targetId);
	if (targetIndex === -1) return items;
	const insertAt = side === "after" ? targetIndex + 1 : targetIndex;
	without.splice(insertAt, 0, moved);
	return without;
}

export function normalizeExternalApps(
	apps: ExternalApp[],
): ExternalApp[] | undefined {
	const validApps = apps.filter(
		(app) => app.name.trim() && app.macAppName.trim(),
	);
	return validApps.length > 0 ? validApps : undefined;
}

/** dev3's permission modes in Copilot's own flags — mirrors `copilotAdapter`. */
const COPILOT_PREVIEW_MODE_ARGS: Record<string, string[]> = {
	plan: ["--mode", "plan"],
	acceptEdits: ["--allow-tool", "write"],
	auto: ["--allow-all-tools"],
	dontAsk: ["--allow-all-tools", "--no-ask-user"],
	bypassPermissions: ["--allow-all"],
};

function quoteIfUnsafeForPreview(s: string): string {
	return /^[A-Za-z0-9_\-./:]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildCommandPreview(
	agentBaseCommand: string,
	config: AgentConfiguration,
	llmProvider?: LlmProvider,
	providerConfig?: ProviderConfig,
	agentFamily?: AgentFamily,
	catalog?: ModelCatalog,
): { command: string; envLine: string | null } {
	const baseCmd = config.baseCommandOverride || agentBaseCommand || "???";
	const parts: string[] = [baseCmd];

	// Mirror the launcher: which CLI this is, not what the file happens to be
	// called — a declared wrapper previews the flags it will actually get.
	const cmdName = agentKey(baseCmd, agentFamily);
	const isCursor = cmdName === "agent";
	const isCodex = cmdName === "codex";
	const isClaude = cmdName === "claude";
	const isCopilot = cmdName === "copilot";
	const isOmp = cmdName === "omp";

	// Mirror the launcher: only a backend registered for THIS agent applies
	// (same guard as agentProvider in agents.ts).
	const def = getProviderDefinition(llmProvider);
	const providerDef = def && def.agentCommand === cmdName ? def : undefined;
	// Env-delivering backends (Claude on Bedrock) omit --model — the alias would
	// be rejected with a 400; the pinned model rides ANTHROPIC_MODEL instead.
	// Flag-delivering backends (Codex on Bedrock) show the rewritten pinned id.
	const modelViaEnv = providerDef?.modelEnv != null;
	// Bound model roles rewrite the launch's own --model, so the preview has to
	// name the catalog model too — otherwise it shows a model that never runs.
	const rolePlan = catalog
		? resolveModelRoleLaunch(cmdName, config.modelRoles, catalog, PREVIEW_RUNTIME, config.model)
		: undefined;
	const previewModel =
		rolePlan?.modelFlag ??
		(providerDef && !modelViaEnv && config.model
			? (providerPinnedModel(llmProvider, providerConfig, config.model) ?? config.model)
			: config.model);

	// Env channel → no --model at all; flag channel → the (possibly pinned) model.
	if (!modelViaEnv && previewModel) {
		// Match the actual launcher: quote when the value would otherwise be
		// glob-expanded by the shell (e.g. `claude-opus-4-8[1m]`).
		parts.push("--model", quoteIfUnsafeForPreview(previewModel));
	}
	// Backend routing args, then the role overrides — the launcher's own order.
	for (const arg of [...(providerDef?.enableArgs ?? []), ...(rolePlan?.args ?? [])]) {
		parts.push(quoteIfUnsafeForPreview(arg));
	}

	// omp is explicit for every mode, `default` included — no flag means its own
	// configured tier, `yolo` out of the box (see omp-flags.ts).
	if (isOmp) {
		if (!hasOmpFlag(config.additionalArgs, "--approval-mode")) {
			parts.push("--approval-mode", OMP_APPROVAL_MODE[config.permissionMode ?? "default"]);
		}
	} else if (!isCodex && config.permissionMode && config.permissionMode !== "default") {
		if (isCursor) {
			if (config.permissionMode === "plan") {
				parts.push("--mode", "plan");
			} else if (config.permissionMode === "bypassPermissions") {
				parts.push("--force");
			}
		} else if (isCopilot) {
			parts.push(...(COPILOT_PREVIEW_MODE_ARGS[config.permissionMode] ?? []));
		} else {
			parts.push("--permission-mode", config.permissionMode);
		}
	}

	// Mirror the launcher: claude always gets --allow-dangerously-skip-permissions
	// (makes bypass available to toggle into, off by default) unless a bypass flag
	// is already present in additionalArgs.
	if (isClaude) {
		const hasBypassFlag = config.additionalArgs?.some(
			(a) => a === "--dangerously-skip-permissions" || a === "--allow-dangerously-skip-permissions",
		);
		if (!hasBypassFlag) parts.push("--allow-dangerously-skip-permissions");
	}

	// Copilot refuses `--model auto --effort <level>` outright; the launcher drops
	// the flag there, so the preview must too.
	if (config.effort && !isCursor && !isCodex && !(isCopilot && config.model === "auto")) {
		if (!isOmp) parts.push("--effort", config.effort);
		else if (!hasOmpFlag(config.additionalArgs, "--thinking")) parts.push("--thinking", config.effort);
	}

	// Copilot budgets in AI credits, not dollars, and omp has no budget flag —
	// the launcher drops this for both.
	if (config.maxBudgetUsd != null && config.maxBudgetUsd > 0 && !isCursor && !isCodex && !isCopilot && !isOmp) {
		parts.push("--max-budget-usd", String(config.maxBudgetUsd));
	}

	if (cmdName === "claude") {
		parts.push("--append-system-prompt-file", "'…dev3 prompt file…'");
	} else if (isOmp) {
		parts.push("--append-system-prompt", "'…dev3 prompt file…'");
	}

	if (config.additionalArgs) {
		for (const arg of config.additionalArgs) {
			if (arg) parts.push(arg);
		}
	}

	let prompt = "{{TASK_DESCRIPTION}}";
	if (config.appendPrompt) {
		prompt += "\\n\\n" + config.appendPrompt;
	}
	if (isCursor) {
		prompt += "\\n\\n…dev3 prompt…";
	}
	// Copilot takes the prompt behind -i, which runs it and STAYS interactive;
	// omp takes it positionally after the `--` separator.
	if (isCopilot) parts.push("-i");
	if (isOmp) parts.push("--");
	parts.push(`'${prompt}'`);

	// Mirror the launcher's env: provider env (Bedrock flag + pinned model)
	// first, then config envVars (which win on conflict, as at launch time).
	const providerEnv = providerDef
		? buildProviderEnv(llmProvider, providerConfig, config.model)
		: {};
	const roleEnv = rolePlan ? { ...rolePlan.env, ...roleUnsetEnv(rolePlan) } : {};
	const envPairs = Object.entries({ ...providerEnv, ...roleEnv, ...config.envVars }).filter(
		// A cleared var is a removal, not an assignment — it has no place on a
		// command line the user could paste.
		([key, value]) => key && value !== ENV_UNSET,
	);
	const envLine =
		envPairs.length > 0
			? envPairs.map(([key, value]) => `${key}=${value}`).join(" ")
			: null;

	return { command: parts.join(" "), envLine };
}
