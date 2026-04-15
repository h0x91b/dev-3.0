import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import type { ExternalApp } from "../shared/types";
import { withFileLock } from "./file-lock";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";

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
	defaultDiffViewMode?: "split" | "unified";
	preventSleepWhileRunning?: boolean;
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
			defaultDiffViewMode: data.defaultDiffViewMode === "unified" ? "unified" : undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
		};
	} catch (err) {
		log.error("Failed to load settings", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: GlobalSettings): Promise<void> {
	log.info("Saving global settings", { settings });
	await withFileLock(SETTINGS_FILE, async () => {
		mkdirSync(DEV3_HOME, { recursive: true });
		const tempFile = `${SETTINGS_FILE}.tmp`;
		await Bun.write(tempFile, JSON.stringify(settings, null, 2));
		renameSync(tempFile, SETTINGS_FILE);
	});
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
			defaultDiffViewMode: data.defaultDiffViewMode === "unified" ? "unified" : undefined,
			preventSleepWhileRunning: data.preventSleepWhileRunning ?? undefined,
		};
	} catch (err) {
		log.error("Failed to load settings (sync)", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}
