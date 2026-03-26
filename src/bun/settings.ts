import { existsSync, readFileSync } from "node:fs";
import type { DiffToolId, ExternalApp } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

const VALID_DIFF_TOOL_IDS: DiffToolId[] = [
	"git-terminal", "vscode", "intellij", "webstorm",
	"kaleidoscope", "beyond-compare", "filemerge", "meld", "custom",
];

const log = createLogger("settings");

const SETTINGS_FILE = `${DEV3_HOME}/settings.json`;

export interface GlobalSettings {
	defaultAgentId: string;
	defaultConfigId: string;
	taskDropPosition: "top" | "bottom";
	updateChannel: "stable" | "canary";
	cloneBaseDirectory?: string;
	customBinaryPaths?: Record<string, string>;
	agentBinaryPaths?: Record<string, string>;
	playSoundOnTaskComplete?: boolean;
	externalApps?: ExternalApp[];
	terminalKeymap?: "default" | "iterm2";
	taskOpenMode?: "split" | "fullscreen";
	preventSleepWhileRunning?: boolean;
	diffTool?: DiffToolId;
	customDiffCommand?: string;
}

const DEFAULT_SETTINGS: GlobalSettings = {
	defaultAgentId: "builtin-claude",
	defaultConfigId: "claude-default",
	taskDropPosition: "top",
	updateChannel: "stable",
};

export async function loadSettings(): Promise<GlobalSettings> {
	try {
		const file = Bun.file(SETTINGS_FILE);
		if (!(await file.exists())) {
			return { ...DEFAULT_SETTINGS };
		}
		const data = await file.json();
		return {
			defaultAgentId: data.defaultAgentId ?? DEFAULT_SETTINGS.defaultAgentId,
			defaultConfigId: data.defaultConfigId ?? DEFAULT_SETTINGS.defaultConfigId,
			taskDropPosition: data.taskDropPosition === "bottom" ? "bottom" : "top",
			updateChannel: data.updateChannel === "canary" ? "canary" : "stable",
			cloneBaseDirectory: data.cloneBaseDirectory ?? undefined,
			customBinaryPaths: data.customBinaryPaths ?? undefined,
			agentBinaryPaths: data.agentBinaryPaths ?? undefined,
			playSoundOnTaskComplete: data.playSoundOnTaskComplete ?? true,
			externalApps: Array.isArray(data.externalApps) ? data.externalApps : undefined,
			terminalKeymap: data.terminalKeymap === "iterm2" ? "iterm2" : undefined,
			taskOpenMode: data.taskOpenMode === "fullscreen" ? "fullscreen" : undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
			diffTool: VALID_DIFF_TOOL_IDS.includes(data.diffTool) ? data.diffTool : undefined,
			customDiffCommand: typeof data.customDiffCommand === "string" ? data.customDiffCommand : undefined,
		};
	} catch (err) {
		log.error("Failed to load settings", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}

export { VALID_DIFF_TOOL_IDS };

export async function saveSettings(settings: GlobalSettings): Promise<void> {
	log.info("Saving global settings", { settings });
	await Bun.write(SETTINGS_FILE, JSON.stringify(settings, null, 2));
	log.info("Global settings saved");
}

export function loadSettingsSync(): GlobalSettings {
	try {
		if (!existsSync(SETTINGS_FILE)) {
			return { ...DEFAULT_SETTINGS };
		}
		const data = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
		return {
			defaultAgentId: data.defaultAgentId ?? DEFAULT_SETTINGS.defaultAgentId,
			defaultConfigId: data.defaultConfigId ?? DEFAULT_SETTINGS.defaultConfigId,
			taskDropPosition: data.taskDropPosition === "bottom" ? "bottom" : "top",
			updateChannel: data.updateChannel === "canary" ? "canary" : "stable",
			cloneBaseDirectory: data.cloneBaseDirectory ?? undefined,
			customBinaryPaths: data.customBinaryPaths ?? undefined,
			agentBinaryPaths: data.agentBinaryPaths ?? undefined,
			playSoundOnTaskComplete: data.playSoundOnTaskComplete ?? true,
			externalApps: Array.isArray(data.externalApps) ? data.externalApps : undefined,
			terminalKeymap: data.terminalKeymap === "iterm2" ? "iterm2" : undefined,
			taskOpenMode: data.taskOpenMode === "fullscreen" ? "fullscreen" : undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
			diffTool: VALID_DIFF_TOOL_IDS.includes(data.diffTool) ? data.diffTool : undefined,
			customDiffCommand: typeof data.customDiffCommand === "string" ? data.customDiffCommand : undefined,
		};
	} catch (err) {
		log.error("Failed to load settings (sync)", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}
