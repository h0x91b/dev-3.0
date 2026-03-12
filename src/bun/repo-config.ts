import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Project, Dev3RepoConfig, ConfigSourceEntry } from "../shared/types";
import { DEV3_REPO_CONFIG_KEYS } from "../shared/types";
import { createLogger } from "./logger";

const log = createLogger("repo-config");

const CONFIG_DIR = ".dev3";
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const LOCAL_CONFIG_FILE = `${CONFIG_DIR}/config.local.json`;

/** Read and parse a JSON file, returning null if missing or corrupt. */
function readJsonFile<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as T;
	} catch (err) {
		log.warn("Failed to read config file", { path, error: String(err) });
		return null;
	}
}

/**
 * Load merged repo config: .dev3/config.json + .dev3/config.local.json.
 * Local overrides repo. Returns {} if no files exist.
 */
export async function loadRepoConfig(projectPath: string): Promise<Dev3RepoConfig> {
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${CONFIG_FILE}`);
	const localConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${LOCAL_CONFIG_FILE}`);

	if (!repoConfig && !localConfig) return {};

	const merged: Dev3RepoConfig = {};
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const localVal = localConfig?.[key];
		const repoVal = repoConfig?.[key];
		if (localVal !== undefined) {
			(merged as any)[key] = localVal;
		} else if (repoVal !== undefined) {
			(merged as any)[key] = repoVal;
		}
	}
	return merged;
}

/** Write config to .dev3/config.json. Creates .dev3/ directory if needed. */
export async function saveRepoConfig(projectPath: string, config: Dev3RepoConfig): Promise<void> {
	mkdirSync(`${projectPath}/${CONFIG_DIR}`, { recursive: true });
	const filePath = `${projectPath}/${CONFIG_FILE}`;
	writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
	log.info("Saved repo config", { path: filePath });
	await ensureGitignore(projectPath);
}

/** Write config to .dev3/config.local.json. Creates .dev3/ directory if needed. */
export async function saveRepoLocalConfig(projectPath: string, config: Dev3RepoConfig): Promise<void> {
	mkdirSync(`${projectPath}/${CONFIG_DIR}`, { recursive: true });
	const filePath = `${projectPath}/${LOCAL_CONFIG_FILE}`;
	writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
	log.info("Saved local repo config", { path: filePath });
	await ensureGitignore(projectPath);
}

/** Ensure .dev3/config.local.json is in the repo's .gitignore. */
export async function ensureGitignore(projectPath: string): Promise<void> {
	const gitignorePath = `${projectPath}/.gitignore`;
	const entry = ".dev3/config.local.json";

	let content = "";
	if (existsSync(gitignorePath)) {
		content = readFileSync(gitignorePath, "utf-8");
	}

	// Check if already present (exact line match)
	const lines = content.split("\n");
	if (lines.some((line) => line.trim() === entry)) return;

	const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	const addition = `${suffix}\n# dev-3.0 local config\n${entry}\n`;
	writeFileSync(gitignorePath, content + addition);
	log.info("Added config.local.json to .gitignore", { path: gitignorePath });
}

/**
 * Return per-field source provenance for UI display.
 * Checks which fields come from repo config, local config, or global (projects.json).
 */
export async function getConfigSources(
	projectPath: string,
	_globalProject: Project,
): Promise<ConfigSourceEntry[]> {
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${CONFIG_FILE}`);
	const localConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${LOCAL_CONFIG_FILE}`);

	return DEV3_REPO_CONFIG_KEYS.map((field) => {
		if (localConfig && localConfig[field] !== undefined) {
			return { field, source: "local" as const };
		}
		if (repoConfig && repoConfig[field] !== undefined) {
			return { field, source: "repo" as const };
		}
		return { field, source: "global" as const };
	});
}

/**
 * Merge repo config on top of a project. Returns a new object (does not mutate original).
 * Priority: global (projects.json) < .dev3/config.json < .dev3/config.local.json
 */
export async function mergeRepoConfig(project: Project): Promise<Project> {
	const config = await loadRepoConfig(project.path);
	if (Object.keys(config).length === 0) return project;

	const merged = { ...project };
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		if (config[key] !== undefined) {
			(merged as any)[key] = config[key];
		}
	}
	return merged;
}

/** Check if a .dev3/config.json file exists in the project. */
export function hasRepoConfig(projectPath: string): boolean {
	return existsSync(`${projectPath}/${CONFIG_FILE}`);
}
