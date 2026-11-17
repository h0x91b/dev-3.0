import { isCoordinatorTask } from "../../shared/types";
import {
	PROJECT_CLI_SETTING_KEYS,
	PROJECT_SETTING_FORBIDDEN_PREFIX,
	isProjectCliSettingKey,
	parseProjectCliSettingValue,
	readProjectCliSettings,
} from "../../shared/project-cli-settings";
import * as data from "../data";
import type { Handler } from "./shared";
import { resolveTaskAcrossProjects } from "./task-resolution";

/**
 * These switches change how every task of the project runs, so only the user
 * (no task context) and coordinators may flip them - the same rule as
 * `dev3 epic create`. Any other agent asks the user.
 */
async function assertMayChangeProjectSetting(sourceTaskId: unknown, key: string): Promise<void> {
	const ref = typeof sourceTaskId === "string" ? sourceTaskId.trim() : "";
	if (!ref) return;
	const found = await resolveTaskAcrossProjects(ref);
	if (found && isCoordinatorTask(found.task)) return;
	throw new Error(
		`${PROJECT_SETTING_FORBIDDEN_PREFIX}Only the user or a coordinator task can change ${key}. Ask the user to switch it in Project Settings, or to run this command from a terminal outside any task.`,
	);
}

// Lazy: the settings handlers pull in the whole settings stack.
async function updateProjectSettings(...args: Parameters<typeof import("../rpc-handlers/settings-config").settingsConfigHandlers.updateProjectSettings>) {
	const { settingsConfigHandlers } = await import("../rpc-handlers/settings-config");
	return settingsConfigHandlers.updateProjectSettings(...args);
}

function requireProjectId(params: Record<string, unknown>): string {
	const projectId = typeof params.projectId === "string" ? params.projectId : "";
	if (!projectId) throw new Error("projectId is required");
	return projectId;
}

export const projectSettingsHandlers: Record<string, Handler> = {
	"projects.settings.get": async (params) => readProjectCliSettings(await data.getProject(requireProjectId(params))),

	"projects.settings.set": async (params) => {
		const projectId = requireProjectId(params);
		const key = String(params.key ?? "");
		if (!isProjectCliSettingKey(key)) throw new Error(`Unknown project setting "${key}". Settable: ${PROJECT_CLI_SETTING_KEYS.join(", ")}`);
		// The CLI parsed the value already; parse again so a raw socket caller gets the same rules.
		const value = parseProjectCliSettingValue(key, String(params.value ?? ""));
		if (value instanceof Error) throw value;
		await assertMayChangeProjectSetting(params.sourceTaskId, key);
		const before = readProjectCliSettings(await data.getProject(projectId))[key];
		const updated = await updateProjectSettings({ projectId, [key]: value });
		return { key, previous: before, value: readProjectCliSettings(updated)[key] };
	},
};
