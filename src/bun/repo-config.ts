import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Project, Dev3RepoConfig, ConfigSourceEntry } from "../shared/types";
import { DEV3_REPO_CONFIG_KEYS } from "../shared/types";
import { createLogger } from "./logger";
import * as git from "./git";

const log = createLogger("repo-config");

const CONFIG_DIR = ".dev3";
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const LOCAL_CONFIG_FILE = `${CONFIG_DIR}/config.local.json`;

/**
 * Treat empty arrays as "not configured" so they fall through the cascade.
 * A config file that contains `clonePaths: []` should not shadow a project-level
 * `clonePaths: ["node_modules"]`. See #378.
 */
function effective<T>(val: T): T | undefined {
	if (val === undefined || val === null) return undefined;
	if (Array.isArray(val) && val.length === 0) return undefined;
	return val;
}

/** Default values for settings fields when nothing is configured. */
const DEFAULTS: Dev3RepoConfig = {
	setupScript: "",
	setupScriptLaunchMode: "parallel",
	devScript: "",
	cleanupScript: "",
	clonePaths: [],
	defaultBaseBranch: "main",
	autoReviewEnabled: false,
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
 * Sources: "local" (.dev3/config.local.json), "repo" (.dev3/config.json).
 * Fields not set in any config file have no entry.
 */
export async function getConfigSources(projectPath: string): Promise<ConfigSourceEntry[]> {
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${CONFIG_FILE}`);
	const localConfig = readJsonFile<Dev3RepoConfig>(`${projectPath}/${LOCAL_CONFIG_FILE}`);

	const entries: ConfigSourceEntry[] = [];
	for (const field of DEV3_REPO_CONFIG_KEYS) {
		if (localConfig && effective(localConfig[field]) !== undefined) {
			entries.push({ field, source: "local" });
		} else if (repoConfig && effective(repoConfig[field]) !== undefined) {
			entries.push({ field, source: "repo" });
		}
	}
	return entries;
}

/**
 * Build the ordered raw config layers for one path (highest → lowest):
 * .dev3/config.local.json (personal, gitignored), then .dev3/config.json (committed).
 */
function pathConfigLayers(basePath: string): (Dev3RepoConfig | null)[] {
	return [
		readJsonFile<Dev3RepoConfig>(`${basePath}/${LOCAL_CONFIG_FILE}`),
		readJsonFile<Dev3RepoConfig>(`${basePath}/${CONFIG_FILE}`),
	];
}

/**
 * Merge config layers (highest priority first) onto the project object, then
 * DEFAULTS — the single source of truth for the config cascade. Shared by
 * single-path resolution (resolveProjectConfig) and worktree+main resolution
 * (resolveOperationalProjectConfig) so the rules live in exactly one place.
 *
 * Per field, the first layer with an "effective" value wins (empty arrays count
 * as "not configured" so a phantom `[]` can't shadow a real value, #378), then
 * the project object, then DEFAULTS. `compareRefBasePath` is the dir used to
 * auto-detect `defaultCompareRef` when nothing sets it (skipped if missing).
 */
async function applyConfigCascade(
	project: Project,
	layers: (Dev3RepoConfig | null)[],
	compareRefBasePath: string,
): Promise<Project> {
	const resolved = { ...project };
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		let val: unknown;
		for (const layer of layers) {
			const v = effective(layer?.[key]);
			if (v !== undefined) { val = v; break; }
		}
		val = val ?? (project as any)[key] ?? DEFAULTS[key];
		if (val !== undefined) (resolved as any)[key] = val;
	}

	// defaultCompareRef: explicit value wins; else derive from mode + base branch;
	// else auto-detect from git (resilient to a missing/broken folder). Merge raw
	// layer values low→high so the highest-priority layer wins, matching the cascade.
	const merged: Dev3RepoConfig = {};
	for (let i = layers.length - 1; i >= 0; i--) Object.assign(merged, layers[i] ?? {});
	if (merged.defaultCompareRef !== undefined) {
		resolved.defaultCompareRef = merged.defaultCompareRef;
	} else if (merged.defaultCompareRefMode !== undefined) {
		resolved.defaultCompareRef = merged.defaultCompareRefMode === "local"
			? resolved.defaultBaseBranch
			: `origin/${resolved.defaultBaseBranch}`;
	} else if (resolved.defaultCompareRef === undefined) {
		// A deleted project folder (or any git/spawn failure) must not reject — one broken
		// project would otherwise blow up the whole project list (Promise.all in getProjects).
		if (!existsSync(compareRefBasePath)) {
			resolved.defaultCompareRef = resolved.defaultBaseBranch;
		} else {
			try {
				resolved.defaultCompareRef = await git.detectDefaultCompareRef(compareRefBasePath, resolved.defaultBaseBranch);
			} catch (err) {
				log.warn("Failed to detect default compare ref, falling back to base branch", {
					path: compareRefBasePath,
					error: String(err),
				});
				resolved.defaultCompareRef = resolved.defaultBaseBranch;
			}
		}
	}

	return resolved;
}

/**
 * Resolve project settings from a single path's .dev3 files (highest → lowest):
 * 1. .dev3/config.local.json (personal, gitignored)
 * 2. .dev3/config.json (committed)
 * 3. projects.json field values (the Project object) → then DEFAULTS
 *
 * Per-field, first-defined wins. No deep merge.
 *
 * @param configPath Optional path override to read .dev3/ files from (e.g. worktree path).
 *                   Falls back to project.path when not provided.
 */
export async function resolveProjectConfig(project: Project, configPath?: string): Promise<Project> {
	const basePath = configPath ?? project.path;
	return applyConfigCascade(project, pathConfigLayers(basePath), basePath);
}

/**
 * Resolve config for a task that runs in a WORKTREE, combining the worktree's
 * own .dev3 files with the project main checkout's, in ONE uniform cascade
 * applied to EVERY field (scripts included — no special-casing). Highest → lowest:
 *
 *   1. <worktree>/.dev3/config.local.json   (gitignored, personal)
 *   2. <worktree>/.dev3/config.json         (committed on the task branch)
 *   3. <main>/.dev3/config.local.json       (gitignored, personal)
 *   4. <main>/.dev3/config.json             (committed on the base branch)
 *   5. projects.json field values (Project object, Project Settings UI → Project tab)
 *   6. DEFAULTS
 *
 * Per field, the highest layer that sets it wins (empty arrays = "not set"). The
 * worktree always outranks main, so a stale/empty value from main or the project
 * object can never shadow a worktree value.
 *
 * Lives here (not in settings-config.ts) because it depends only on the config
 * cascade — keeping it pure and integration-testable with real files.
 */
export async function resolveOperationalProjectConfig(project: Project, worktreePath?: string): Promise<Project> {
	// No worktree (or worktree == project root): plain single-path resolution.
	if (!worktreePath || worktreePath === project.path) {
		return resolveProjectConfig(project);
	}
	// Worktree files first, then main checkout's — both as [local, repo].
	const layers = [...pathConfigLayers(worktreePath), ...pathConfigLayers(project.path)];
	// Compare-ref auto-detection uses the worktree dir (matches its branch).
	return applyConfigCascade(project, layers, worktreePath);
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

	// A deleted project folder must not be resurrected by mkdirSync in saveRepoConfig
	if (!existsSync(basePath)) return;

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
