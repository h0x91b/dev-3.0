import type {
	AgentConfiguration,
	ExternalApp,
	GlobalSettings,
	LlmProvider,
	ProviderConfig,
} from "../../../shared/types";
import { buildProviderEnv, isThirdPartyProvider } from "../../../shared/llm-provider";

export type Theme = "dark" | "light" | "system";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-auto",
	taskDropPosition: "top",
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

export function moveItem<T>(items: T[], from: number, to: number): T[] {
	if (from === to) return items;
	if (from < 0 || from >= items.length) return items;
	if (to < 0 || to >= items.length) return items;
	const next = items.slice();
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
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

function quoteIfUnsafeForPreview(s: string): string {
	return /^[A-Za-z0-9_\-./:]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function buildCommandPreview(
	agentBaseCommand: string,
	config: AgentConfiguration,
	llmProvider?: LlmProvider,
	providerConfig?: ProviderConfig,
): { command: string; envLine: string | null } {
	const baseCmd = config.baseCommandOverride || agentBaseCommand || "???";
	const parts: string[] = [baseCmd];

	const cmdName = baseCmd.split("/").pop() ?? "";
	const isCursor = cmdName === "agent";
	const isCodex = cmdName === "codex";
	const isClaude = cmdName === "claude";

	// Mirror the launcher: for Claude on a third-party provider, the model comes
	// from the injected provider env (ANTHROPIC_MODEL), so --model is omitted —
	// the Anthropic-API alias would be rejected by the provider with a 400.
	const claudeOnProvider = isClaude && isThirdPartyProvider(llmProvider);

	if (config.model && !claudeOnProvider) {
		// Match the actual launcher: quote when the value would otherwise be
		// glob-expanded by the shell (e.g. `claude-opus-4-8[1m]`).
		parts.push("--model", quoteIfUnsafeForPreview(config.model));
	}

	if (!isCodex && config.permissionMode && config.permissionMode !== "default") {
		if (isCursor) {
			if (config.permissionMode === "plan") {
				parts.push("--mode", "plan");
			} else if (config.permissionMode === "bypassPermissions") {
				parts.push("--force");
			}
		} else {
			parts.push("--permission-mode", config.permissionMode);
		}
	}

	if (config.effort && !isCursor && !isCodex) {
		parts.push("--effort", config.effort);
	}

	if (config.maxBudgetUsd != null && config.maxBudgetUsd > 0 && !isCursor && !isCodex) {
		parts.push("--max-budget-usd", String(config.maxBudgetUsd));
	}

	if (cmdName === "claude") {
		parts.push("--append-system-prompt", "'…dev3 prompt…'");
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
	parts.push(`'${prompt}'`);

	// Mirror the launcher's env: provider env (Bedrock flag + pinned model)
	// first, then config envVars (which win on conflict, as at launch time).
	const providerEnv = claudeOnProvider
		? buildProviderEnv(llmProvider, providerConfig, config.model)
		: {};
	const envPairs = Object.entries({ ...providerEnv, ...config.envVars }).filter(
		([key]) => key,
	);
	const envLine =
		envPairs.length > 0
			? envPairs.map(([key, value]) => `${key}=${value}`).join(" ")
			: null;

	return { command: parts.join(" "), envLine };
}
