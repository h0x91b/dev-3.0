import type {
	AgentConfiguration,
	ExternalApp,
	GlobalSettings,
} from "../../../shared/types";

export type Theme = "dark" | "light" | "system";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-default",
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

export function toStoredDiffViewMode(
	mode: "split" | "unified",
): GlobalSettings["defaultDiffViewMode"] {
	return mode === "unified" ? "unified" : undefined;
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

export function normalizeExternalApps(
	apps: ExternalApp[],
): ExternalApp[] | undefined {
	const validApps = apps.filter(
		(app) => app.name.trim() && app.macAppName.trim(),
	);
	return validApps.length > 0 ? validApps : undefined;
}

export function buildCommandPreview(
	agentBaseCommand: string,
	config: AgentConfiguration,
): { command: string; envLine: string | null } {
	const baseCmd = config.baseCommandOverride || agentBaseCommand || "???";
	const parts: string[] = [baseCmd];

	if (config.model) {
		parts.push("--model", config.model);
	}

	const cmdName = baseCmd.split("/").pop() ?? "";
	const isCursor = cmdName === "agent";
	const isCodex = cmdName === "codex";

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

	const envPairs = Object.entries(config.envVars || {}).filter(([key]) => key);
	const envLine =
		envPairs.length > 0
			? envPairs.map(([key, value]) => `${key}=${value}`).join(" ")
			: null;

	return { command: parts.join(" "), envLine };
}
