import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Project, Dev3RepoConfig, ConfigSourceEntry } from "../shared/types";
import { DEV3_REPO_CONFIG_KEYS } from "../shared/types";
import { createLogger } from "./logger";
import { DEV3_HOME } from "./paths";
import { projectSlug } from "./git";

const log = createLogger("repo-config");

const CONFIG_DIR = ".dev3";
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const LOCAL_CONFIG_FILE = `${CONFIG_DIR}/config.local.json`;

/** Default values for settings fields when nothing is configured. */
const DEFAULTS: Dev3RepoConfig = {
	setupScript: "",
	devScript: "",
	cleanupScript: "",
	clonePaths: [],
	defaultBaseBranch: "main",
	peerReviewEnabled: true,
	sparseCheckoutEnabled: false,
	sparseCheckoutPaths: [],
};

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

/** Load raw .dev3/config.json content. Returns {} if missing. */
export function loadRepoConfigRaw(projectPath: string): Dev3RepoConfig {
	return readJsonFile<Dev3RepoConfig>(`${projectPath}/${CONFIG_FILE}`) ?? {};
}

/** Load raw .dev3/config.local.json content. Returns {} if missing. */
export function loadLocalConfigRaw(projectPath: string): Dev3RepoConfig {
	return readJsonFile<Dev3RepoConfig>(`${projectPath}/${LOCAL_CONFIG_FILE}`) ?? {};
}

/**
 * Load merged repo config: .dev3/config.json + .dev3/config.local.json.
 * Local overrides repo. Only includes known keys. Returns {} if no files exist.
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

/** Path to app-level config for a project: ~/.dev3.0/data/<slug>/config.json */
function appConfigPath(projectPath: string): string {
	return `${DEV3_HOME}/data/${projectSlug(projectPath)}/config.json`;
}

/** Load app-level config (~/.dev3.0/data/<slug>/config.json). Returns {} if missing. */
export function loadAppConfig(projectPath: string): Dev3RepoConfig {
	return readJsonFile<Dev3RepoConfig>(appConfigPath(projectPath)) ?? {};
}

/** Save app-level config to ~/.dev3.0/data/<slug>/config.json. */
export async function saveAppConfig(projectPath: string, config: Dev3RepoConfig): Promise<void> {
	const filePath = appConfigPath(projectPath);
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
	log.info("Saved app config", { path: filePath });
}

/** Check if app-level config exists for this project. */
export function hasAppConfig(projectPath: string): boolean {
	return existsSync(appConfigPath(projectPath));
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
 * Sources: "local" (.dev3/config.local.json), "repo" (.dev3/config.json), "app" (app-level).
 * Fields not set in any config file have no entry.
 */
export async function getConfigSources(
	projectPath: string,
	originalProjectPath?: string,
): Promise<ConfigSourceEntry[]> {
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${CONFIG_FILE}`);
	const localConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${LOCAL_CONFIG_FILE}`);
	const appConfig = loadAppConfig(originalProjectPath ?? projectPath);

	const entries: ConfigSourceEntry[] = [];
	for (const field of DEV3_REPO_CONFIG_KEYS) {
		if (localConfig && localConfig[field] !== undefined) {
			entries.push({ field, source: "local" });
		} else if (repoConfig && repoConfig[field] !== undefined) {
			entries.push({ field, source: "repo" });
		} else if (appConfig[field] !== undefined) {
			entries.push({ field, source: "app" });
		}
	}
	return entries;
}

/**
 * Resolve project settings using 4-level hierarchy (highest → lowest priority):
 * 1. .dev3/config.local.json in configPath — personal overrides, gitignored
 * 2. .dev3/config.json in configPath — branch config, committed to git
 * 3. ~/.dev3.0/data/<slug>/config.json — app-level project config (NOT in git)
 * 4. projects.json field values (on the Project object) → then DEFAULTS
 *
 * Per-field, first-defined wins. No deep merge.
 *
 * @param configPath Optional path override to read .dev3/ files from (e.g. worktree path).
 *                   Falls back to project.path when not provided.
 */
export async function resolveProjectConfig(project: Project, configPath?: string): Promise<Project> {
	const basePath = configPath ?? project.path;
	const localConfig = readJsonFile<Dev3RepoConfig>(`${basePath}/${LOCAL_CONFIG_FILE}`);
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${basePath}/${CONFIG_FILE}`);
	const appConfig = loadAppConfig(project.path); // always from project.path, not worktree

	const resolved = { ...project };
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const val = localConfig?.[key] ?? repoConfig?.[key] ?? appConfig?.[key] ?? (project as any)[key] ?? DEFAULTS[key];
		if (val !== undefined) (resolved as any)[key] = val;
	}
	return resolved;
}

/**
 * One-time migration: if no .dev3/config.json exists, create it from
 * settings stored in projects.json. Runs automatically on project load.
 *
 * @param configPath Optional path override for .dev3/ files (e.g. worktree path).
 */
export async function migrateProjectConfig(project: Project, configPath?: string): Promise<void> {
	const basePath = configPath ?? project.path;
	const repoPath = `${basePath}/${CONFIG_FILE}`;
	const localPath = `${basePath}/${LOCAL_CONFIG_FILE}`;

	// Skip if any .dev3/ config already exists
	if (existsSync(repoPath) || existsSync(localPath)) return;

	// Check if project has any non-default settings worth migrating
	const config: Dev3RepoConfig = {};
	let hasSettings = false;
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const val = (project as any)[key];
		if (val !== undefined && val !== DEFAULTS[key]) {
			// For arrays, check if non-empty
			if (Array.isArray(val) && val.length === 0) continue;
			// For strings, check if non-empty
			if (typeof val === "string" && val.trim() === "") continue;
			(config as any)[key] = val;
			hasSettings = true;
		}
	}

	if (!hasSettings) return;

	log.info("Migrating project settings to .dev3/config.json", {
		path: basePath,
		fields: Object.keys(config),
	});
	await saveRepoConfig(basePath, config);
}

/** Check if a .dev3/config.json file exists in the project. */
export function hasRepoConfig(projectPath: string): boolean {
	return existsSync(`${projectPath}/${CONFIG_FILE}`);
}

/** Check if a .dev3/config.local.json file exists in the project. */
export function hasLocalConfig(projectPath: string): boolean {
	return existsSync(`${projectPath}/${LOCAL_CONFIG_FILE}`);
}
