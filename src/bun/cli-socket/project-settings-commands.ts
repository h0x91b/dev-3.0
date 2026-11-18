import { isCoordinatorTask, type Project } from "../../shared/types";
import {
	PROJECT_CLI_SETTING_KEYS,
	PROJECT_SETTING_FORBIDDEN_PREFIX,
	PROJECT_SETTING_UNAVAILABLE_PREFIX,
	isProjectCliSettingKey,
	parseProjectCliSettingValue,
	readProjectCliSettings,
	type ProjectCliSettingKey,
	type ProjectCliSettingValue,
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

/**
 * Refuses a value Project Settings would not offer in this state, so the CLI
 * cannot leave a switch the user can neither see nor clear. The UI shows the
 * messages toggle only while boardCopy is on, and an operations board has no
 * folder to copy into (updateProjectSettings would drop it without a word).
 */
function assertSettingApplies(project: Project, key: ProjectCliSettingKey, value: ProjectCliSettingValue): void {
	if (key === "boardCopy" && value === true && project.kind === "virtual") {
		throw new Error(`${PROJECT_SETTING_UNAVAILABLE_PREFIX}Operations boards have no project folder to copy the board into.`);
	}
	if (key === "boardCopyMessages" && value === true && project.boardCopy !== true) {
		throw new Error(`${PROJECT_SETTING_UNAVAILABLE_PREFIX}boardCopyMessages needs boardCopy. Turn boardCopy on first: dev3 projects set boardCopy on`);
	}
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
		const project = await data.getProject(projectId);
		assertSettingApplies(project, key, value);
		const before = readProjectCliSettings(project)[key];
		const updated = await updateProjectSettings({ projectId, [key]: value });
		return { key, previous: before, value: readProjectCliSettings(updated)[key] };
	},
};
