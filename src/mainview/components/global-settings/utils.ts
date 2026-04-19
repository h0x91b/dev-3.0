import type {
	AgentConfiguration,
	ExternalApp,
	GlobalSettings,
	TasksQuickSwitchShortcut,
} from "../../../shared/types";
import {
	DEFAULT_TASKS_QUICK_SWITCH_FILTERS,
	DEFAULT_TASKS_QUICK_SWITCH_SHORTCUT,
	normalizeTasksQuickSwitchShortcut,
} from "../../../shared/types";

export type Theme = "dark" | "light" | "system";
export const TASKS_QUICK_SWITCH_SHORTCUT_LS_KEY =
	"dev3-tasks-quick-switch-shortcut";
const LEGACY_TASKS_QUICK_SWITCH_SHORTCUT_MODIFIER_LS_KEY =
	"dev3-tasks-quick-switch-shortcut-modifier";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-default",
	taskDropPosition: "top",
	updateChannel: "stable",
	tasksQuickSwitchFilters: [...DEFAULT_TASKS_QUICK_SWITCH_FILTERS],
	tasksQuickSwitchShortcut: { ...DEFAULT_TASKS_QUICK_SWITCH_SHORTCUT },
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

export function getStoredTasksQuickSwitchShortcut(): TasksQuickSwitchShortcut {
	const raw = localStorage.getItem(TASKS_QUICK_SWITCH_SHORTCUT_LS_KEY);
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			return normalizeTasksQuickSwitchShortcut(parsed);
		} catch {
			// Ignore malformed local cache and fall back to defaults below.
		}
	}
	return normalizeTasksQuickSwitchShortcut(
		null,
		localStorage.getItem(LEGACY_TASKS_QUICK_SWITCH_SHORTCUT_MODIFIER_LS_KEY),
	);
}

export function setStoredTasksQuickSwitchShortcut(
	shortcut: TasksQuickSwitchShortcut,
): void {
	localStorage.setItem(
		TASKS_QUICK_SWITCH_SHORTCUT_LS_KEY,
		JSON.stringify(shortcut),
	);
	localStorage.removeItem(LEGACY_TASKS_QUICK_SWITCH_SHORTCUT_MODIFIER_LS_KEY);
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
