import type { Project, ProjectSettingsUpdate } from "./types/project";
import { hasGitWorkflow, repoConfigEnabled } from "./types/project";

/**
 * The machine-local Project Settings switches `dev3 projects get|set` reaches.
 * They live in `projects.json`, not in a `.dev3` file, so `dev3 config` cannot
 * write them. Each key maps 1:1 onto a {@link ProjectSettingsUpdate} field.
 */
export const PROJECT_CLI_SETTINGS = {
	name: { kind: "string", summary: "Display name. The folder and the board data never move." },
	gitWorkflow: { kind: "boolean", summary: "Worktrees, branches, diffs, PRs and review columns. off = tasks share the project folder." },
	storageRoot: { kind: "enum", values: ["home", "project"], summary: "Where board data and new task dirs live: home = ~/.dev3.0, project = <folder>/.dev3/." },
	useRepoConfig: { kind: "boolean", summary: "Read the project's .dev3/config.json and .dev3/config.local.json." },
	boardCopy: { kind: "boolean", summary: "Keep a one-way copy of the board in <folder>/.dev3/board/." },
	boardCopyMessages: { kind: "boolean", summary: "Also copy the messages the board's agents received (needs boardCopy)." },
} as const satisfies Record<string, { kind: "string" | "boolean" | "enum"; values?: readonly string[]; summary: string }>;

export type ProjectCliSettingKey = keyof typeof PROJECT_CLI_SETTINGS & keyof ProjectSettingsUpdate;
export type ProjectCliSettingValue = string | boolean;

export const PROJECT_CLI_SETTING_KEYS = Object.keys(PROJECT_CLI_SETTINGS) as ProjectCliSettingKey[];

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_PROJECT_SETTING_FORBIDDEN`. */
export const PROJECT_SETTING_FORBIDDEN_PREFIX = "project-setting-forbidden: ";

/** Error prefix that makes the CLI exit with `CLI_EXIT_CODE_PROJECT_SETTING_UNAVAILABLE`. */
export const PROJECT_SETTING_UNAVAILABLE_PREFIX = "project-setting-unavailable: ";

export function isProjectCliSettingKey(key: string): key is ProjectCliSettingKey {
	return Object.prototype.hasOwnProperty.call(PROJECT_CLI_SETTINGS, key);
}

const TRUE_WORDS = new Set(["on", "true", "yes", "1"]);
const FALSE_WORDS = new Set(["off", "false", "no", "0"]);

/** The typed value for `key`, or an Error naming what the key accepts. */
export function parseProjectCliSettingValue(key: ProjectCliSettingKey, raw: string): ProjectCliSettingValue | Error {
	const spec = PROJECT_CLI_SETTINGS[key];
	const word = raw.trim().toLowerCase();
	if (spec.kind === "boolean") {
		if (TRUE_WORDS.has(word)) return true;
		if (FALSE_WORDS.has(word)) return false;
		return new Error(`${key} takes on or off, not "${raw}"`);
	}
	if (spec.kind === "enum") {
		const values: readonly string[] = spec.values;
		return values.includes(word) ? word : new Error(`${key} takes ${values.join(" or ")}, not "${raw}"`);
	}
	return raw.trim() ? raw.trim() : new Error(`${key} cannot be blank`);
}

/** What each key resolves to for `project` right now, defaults filled in. */
export function readProjectCliSettings(project: Project): Record<ProjectCliSettingKey, ProjectCliSettingValue> {
	return {
		name: project.name,
		gitWorkflow: hasGitWorkflow(project),
		storageRoot: project.storageRoot === "project" ? "project" : "home",
		useRepoConfig: repoConfigEnabled(project),
		boardCopy: project.boardCopy === true,
		boardCopyMessages: project.boardCopyMessages === true,
	};
}

/** How a value prints in plain output: booleans as on/off, like the parser takes them. */
export function formatProjectCliSettingValue(value: ProjectCliSettingValue): string {
	return typeof value === "boolean" ? (value ? "on" : "off") : value;
}
