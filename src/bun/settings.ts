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
		};
	} catch (err) {
		log.error("Failed to load settings", { error: String(err) });
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(settings: GlobalSettings): Promise<void> {
	log.info("Saving global settings", { settings });
	await Bun.write(SETTINGS_FILE, JSON.stringify(settings, null, 2));
	log.info("Global settings saved");
}
