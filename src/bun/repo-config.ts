import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import type { Project, Dev3RepoConfig, ConfigSourceEntry, ResolvedConfigSource } from "../shared/types";
import { DEV3_REPO_CONFIG_KEYS, remapColumnAgents } from "../shared/types";
import { sanitizeEnvMap } from "../shared/env-text";
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
 * Full per-field provenance for the resolved config cascade — used by
 * `dev3 config show` so every key shows exactly where its value came from,
 * never a blanket fallback that hides project/default/unset behind one label.
 *
 * Unlike getConfigSources (repo/local only, for the UI badge), this attributes
 * EVERY key in DEV3_REPO_CONFIG_KEYS to one origin, mirroring applyConfigCascade
 * so the label always matches the value the cascade actually resolved:
 *   local   → effective value in .dev3/config.local.json
 *   repo    → effective value in .dev3/config.json
 *   project → value on the Project object (projects.json), no file value
 *   default → value from DEFAULTS or a derived field (e.g. defaultCompareRef)
 *   unset   → no value at any layer (the CLI renders this "(not set)")
 *
 * `resolved` is the output of resolveProjectConfig for the same project+path;
 * `project` is the raw Project object. Empty arrays count as "not configured"
 * for file layers (matches effective()), so a phantom `[]` can't claim a key.
 */
export function resolveConfigProvenance(
	resolved: Project,
	project: Project,
	configPath?: string,
): Record<string, ResolvedConfigSource> {
	const basePath = configPath ?? project.path;
	const localConfig = readJsonFile<Dev3RepoConfig>(`${basePath}/${LOCAL_CONFIG_FILE}`);
	const repoConfig = readJsonFile<Dev3RepoConfig>(`${basePath}/${CONFIG_FILE}`);
	const provenance: Record<string, ResolvedConfigSource> = {};
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		if (effective(localConfig?.[key]) !== undefined) {
			provenance[key] = "local";
		} else if (effective(repoConfig?.[key]) !== undefined) {
			provenance[key] = "repo";
		} else if ((project as any)[key] != null) {
			provenance[key] = "project";
		} else if ((resolved as any)[key] != null) {
			provenance[key] = "default";
		} else {
			provenance[key] = "unset";
		}
	}
	return provenance;
}

/**
 * Fields a repo file can turn into a running command: a shell script, the
 * environment every session inherits, or an agent dev3 launches by itself.
 * Everything else (paths, branch names, port counts, booleans) shapes behaviour
 * but never executes, so it is read from any layer regardless of provenance.
 */
const COMMAND_BEARING_KEYS: ReadonlySet<keyof Dev3RepoConfig> = new Set([
	"setupScript",
	"setupScriptLaunchMode",
	"devScript",
	"cleanupScript",
	"env",
	"builtinColumnAgents",
]);

/**
 * One config file plus whether its content is trusted to carry commands.
 * `trusted: false` marks a layer read out of a worktree standing on someone
 * else's branch: its non-executable fields still apply, its commands never do.
 */
type ConfigLayer = { config: Dev3RepoConfig | null; trusted: boolean };

/** Layer value for one key, or undefined when this layer may not supply it. */
function layerValue(layer: ConfigLayer, key: keyof Dev3RepoConfig): unknown {
	if (!layer.trusted && COMMAND_BEARING_KEYS.has(key)) return undefined;
	return effective(layer.config?.[key]);
}

/**
 * Build the ordered raw config layers for one path (highest → lowest):
 * .dev3/config.local.json (personal, gitignored), then .dev3/config.json (committed).
 *
 * `trusted` is false only for a foreign-code worktree — see
 * {@link resolveOperationalProjectConfig}. The project's own checkout is always
 * trusted: the user cloned it and its committed config is theirs to own.
 */
function pathConfigLayers(basePath: string, trusted = true): ConfigLayer[] {
	return [
		{ config: readJsonFile<Dev3RepoConfig>(`${basePath}/${LOCAL_CONFIG_FILE}`), trusted },
		{ config: readJsonFile<Dev3RepoConfig>(`${basePath}/${CONFIG_FILE}`), trusted },
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
	layers: ConfigLayer[],
	compareRefBasePath: string,
): Promise<Project> {
	const resolved = { ...project };
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		let val: unknown;
		for (const layer of layers) {
			const v = layerValue(layer, key);
			if (v !== undefined) { val = v; break; }
		}
		val = val ?? (project as any)[key] ?? DEFAULTS[key];
		if (val !== undefined) (resolved as any)[key] = val;
	}
	// A config file may still name a preset that was removed from DEFAULT_AGENTS.
	resolved.builtinColumnAgents = remapColumnAgents(resolved.builtinColumnAgents);

	// `env` merges PER KEY across layers, unlike every other field: a repo file
	// that sets one var must not erase UI- or local-configured vars (decision 179).
	const envMerged = sanitizeEnvMap(project.env, (m) => log.warn(m));
	for (let i = layers.length - 1; i >= 0; i--) {
		Object.assign(envMerged, sanitizeEnvMap(layerValue(layers[i], "env"), (m) => log.warn(m)));
	}
	resolved.env = Object.keys(envMerged).length > 0 ? envMerged : undefined;

	// defaultCompareRef: explicit value wins; else derive from mode + base branch;
	// else auto-detect from git (resilient to a missing/broken folder). Merge raw
	// layer values low→high so the highest-priority layer wins, matching the cascade.
	const merged: Dev3RepoConfig = {};
	for (let i = layers.length - 1; i >= 0; i--) Object.assign(merged, layers[i].config ?? {});
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
 * ONE exception, and it is a security boundary: pass `foreignCode` for a task
 * standing on a branch the user did not write (`Task.foreignCode`). The worktree's
 * layers then stop supplying {@link COMMAND_BEARING_KEYS} — a pull request cannot
 * hand dev3 a `setupScript` or a `BASH_ENV` to run before anyone read the diff.
 * The worktree still supplies everything that does not execute, and the project's
 * own checkout still supplies the commands, so the task launches normally.
 *
 * Lives here (not in settings-config.ts) because it depends only on the config
 * cascade — keeping it pure and integration-testable with real files.
 */
export async function resolveOperationalProjectConfig(
	project: Project,
	worktreePath?: string,
	opts?: { foreignCode?: boolean },
): Promise<Project> {
	// No worktree (or worktree == project root): plain single-path resolution.
	if (!worktreePath || worktreePath === project.path) {
		return resolveProjectConfig(project);
	}
	// Worktree files first, then main checkout's — both as [local, repo].
	const layers = [
		...pathConfigLayers(worktreePath, opts?.foreignCode !== true),
		...pathConfigLayers(project.path),
	];
	// Compare-ref auto-detection uses the worktree dir (matches its branch).
	return applyConfigCascade(project, layers, worktreePath);
}

/** Per-key-merged project env for a terminal or task session, re-read at launch
 *  time so config-file edits apply on the next launch. Never throws.
 *  Pass the task's `foreignCode` so a reviewed branch cannot export env into
 *  every session it touches (see {@link resolveOperationalProjectConfig}). */
export async function resolveProjectEnv(
	project: Project,
	worktreePath?: string | null,
	opts?: { foreignCode?: boolean },
): Promise<Record<string, string>> {
	const resolved = await resolveOperationalProjectConfig(project, worktreePath ?? undefined, opts);
	return resolved.env ?? {};
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
		if (key === "env") continue;
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

/**
 * Route a Project Settings save to the layer that actually wins the cascade.
 *
 * Without this, saving a field that a .dev3 file already defines writes to
 * projects.json, where the file immediately shadows it again — the value looks
 * saved until the next read and then "resets" (the AI Review preset bug).
 *
 * Only keys ALREADY present in an existing file are redirected, so no file is
 * created and no key silently migrates into git. `env` is never redirected: it
 * merges per key across layers (decision 179) and may hold personal secrets.
 *
 * Returns the keys that still belong on the Project object.
 */
export async function saveConfigToWinningLayer(
	basePath: string,
	config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const local = readJsonFile<Dev3RepoConfig>(`${basePath}/${LOCAL_CONFIG_FILE}`);
	const repo = readJsonFile<Dev3RepoConfig>(`${basePath}/${CONFIG_FILE}`);
	const localPatch: Record<string, unknown> = {};
	const repoPatch: Record<string, unknown> = {};
	const leftover: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(config)) {
		const field = key as keyof Dev3RepoConfig;
		if (field !== "env" && local && effective(local[field]) !== undefined) localPatch[key] = value;
		else if (field !== "env" && repo && effective(repo[field]) !== undefined) repoPatch[key] = value;
		else leftover[key] = value;
	}
	if (Object.keys(localPatch).length > 0) {
		writeFileSync(`${basePath}/${LOCAL_CONFIG_FILE}`, JSON.stringify({ ...local, ...localPatch }, null, 2) + "\n");
		log.info("Saved settings into overriding local config", { path: basePath, fields: Object.keys(localPatch) });
	}
	if (Object.keys(repoPatch).length > 0) {
		writeFileSync(`${basePath}/${CONFIG_FILE}`, JSON.stringify({ ...repo, ...repoPatch }, null, 2) + "\n");
		log.info("Saved settings into overriding repo config", { path: basePath, fields: Object.keys(repoPatch) });
	}
	return leftover;
}

/** Check if a .dev3/config.json file exists in the project. */
export function hasRepoConfig(projectPath: string): boolean {
	return existsSync(`${projectPath}/${CONFIG_FILE}`);
}

/** Check if a .dev3/config.local.json file exists in the project. */
export function hasLocalConfig(projectPath: string): boolean {
	return existsSync(`${projectPath}/${LOCAL_CONFIG_FILE}`);
}
