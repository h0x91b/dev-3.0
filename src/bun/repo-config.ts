import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Project, Dev3RepoConfig, ConfigSourceEntry, ResolvedConfigSource } from "../shared/types";
import { DEV3_REPO_CONFIG_KEYS, hasGitWorkflow, remapColumnAgents, repoConfigEnabled } from "../shared/types";
import {
	COMMAND_BEARING_CONFIG_KEYS,
	EXPLICIT_EMPTY_ARRAY_CONFIG_KEYS,
	configDefaults,
	isConfigKey,
	migrateConfig,
	validateConfigFile,
} from "../shared/config-schema";
import { editJsonMember } from "../shared/config-file-edit";
import { sanitizeEnvMap } from "../shared/env-text";
import { applyAgentEnvDefaults } from "../shared/agent-env-defaults";
import { projectClaudeConfigDirAllowed } from "./claude-config-git";
import { loadSettings } from "./settings";
import { createLogger } from "./logger";
import * as git from "./git";

const log = createLogger("repo-config");

const CONFIG_DIR = ".dev3";
const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const LOCAL_CONFIG_FILE = `${CONFIG_DIR}/config.local.json`;

/**
 * Keys whose empty array is an explicit value, not "not configured": `clonePaths: []`
 * in a config file is the only way that file can turn cloning off (#2026).
 */
const EXPLICIT_EMPTY_ARRAY_KEYS: ReadonlySet<keyof Dev3RepoConfig> = EXPLICIT_EMPTY_ARRAY_CONFIG_KEYS;

/**
 * Treat empty arrays as "not configured" so they fall through the cascade — a
 * phantom `sparseCheckoutPaths: []` once written by the UI must not shadow a real
 * value (#378). {@link EXPLICIT_EMPTY_ARRAY_KEYS} are the exception.
 */
function effective<T>(val: T, key: keyof Dev3RepoConfig): T | undefined {
	if (val === undefined || val === null) return undefined;
	if (Array.isArray(val) && val.length === 0 && !EXPLICIT_EMPTY_ARRAY_KEYS.has(key)) return undefined;
	return val;
}

/** Default values for settings fields when nothing is configured: the schema's `default`s. */
const DEFAULTS: Dev3RepoConfig = configDefaults();

/** Read and parse a JSON file, returning null if missing or corrupt. */
function readJsonFile<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed as T;
		// Files from an older schema are migrated in memory only; the next write persists it.
		return migrateConfig(parsed as Record<string, unknown>).config as T;
	} catch (err) {
		log.warn("Failed to read config file", { path, error: String(err) });
		return null;
	}
}

/**
 * Keys a save must carry over from the file it replaces: `schemaVersion` and
 * any key this version does not know, which a newer dev3 may have written.
 */
function foreignKeys(path: string): Record<string, unknown> {
	const existing = readJsonFile<Record<string, unknown>>(path);
	if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {};
	return Object.fromEntries(Object.entries(existing).filter(([key]) => !isConfigKey(key)));
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
	writeFileSync(filePath, JSON.stringify({ ...foreignKeys(filePath), ...config }, null, 2) + "\n");
	log.info("Saved repo config", { path: filePath });
	await ensureGitignore(projectPath);
}

/** Write config to .dev3/config.local.json. Creates .dev3/ directory if needed. */
export async function saveRepoLocalConfig(projectPath: string, config: Dev3RepoConfig): Promise<void> {
	mkdirSync(`${projectPath}/${CONFIG_DIR}`, { recursive: true });
	const filePath = `${projectPath}/${LOCAL_CONFIG_FILE}`;
	writeFileSync(filePath, JSON.stringify({ ...foreignKeys(filePath), ...config }, null, 2) + "\n");
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
		if (localConfig && effective(localConfig[field], field) !== undefined) {
			entries.push({ field, source: "local" });
		} else if (repoConfig && effective(repoConfig[field], field) !== undefined) {
			entries.push({ field, source: "repo" });
		}
	}
	return entries;
}

/**
 * Per-key provenance for `dev3 config show`, over the same layers
 * {@link resolveOperationalProjectConfig} reads for `worktreePath`. Every key
 * gets exactly one origin: a layer id, `project`, `default` or `unset`.
 * `resolved` is that function's output for the same project and path.
 */
export function resolveConfigProvenance(
	resolved: Project,
	project: Project,
	worktreePath?: string,
	opts?: { foreignCode?: boolean },
): Record<string, ResolvedConfigSource> {
	return resolveLayeredProvenance(resolved, project, listConfigLayers(project, worktreePath, opts)).sources;
}

/**
 * Fields a repo file can turn into a running command (schema `executes`): a
 * shell script, the environment every session inherits, or an agent dev3
 * launches by itself. Everything else is read from any layer.
 */
const COMMAND_BEARING_KEYS: ReadonlySet<keyof Dev3RepoConfig> = COMMAND_BEARING_CONFIG_KEYS;

/**
 * One config file plus whether its content is trusted to carry commands.
 * `trusted: false` marks a layer read out of a worktree standing on someone
 * else's branch: its non-executable fields still apply, its commands never do.
 */
type ConfigLayer = { config: Dev3RepoConfig | null; trusted: boolean };

/** Layer value for one key, or undefined when this layer may not supply it. */
function layerValue(layer: ConfigLayer, key: keyof Dev3RepoConfig): unknown {
	if (!layer.trusted && COMMAND_BEARING_KEYS.has(key)) return undefined;
	return effective(layer.config?.[key], key);
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
 * as "not configured" so a phantom `[]` can't shadow a real value, #378 — except
 * `clonePaths: []`, which turns cloning off, #2026), then
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
	// else auto-detect from git. A configured ref the repo lacks falls back to the
	// detected one. Merge raw layer values low→high so the highest-priority layer wins.
	const merged: Dev3RepoConfig = {};
	for (let i = layers.length - 1; i >= 0; i--) Object.assign(merged, layers[i].config ?? {});
	const configuredCompareRef = merged.defaultCompareRef !== undefined
		? merged.defaultCompareRef
		: merged.defaultCompareRefMode !== undefined
			? merged.defaultCompareRefMode === "local" ? resolved.defaultBaseBranch : `origin/${resolved.defaultBaseBranch}`
			: resolved.defaultCompareRef;
	// A deleted project folder (or any git/spawn failure) must not reject — one broken
	// project would otherwise blow up the whole project list (Promise.all in getProjects).
	// Without the git workflow nothing is ever compared, and the folder may not be a repo.
	if (!existsSync(compareRefBasePath) || !hasGitWorkflow(project)) {
		resolved.defaultCompareRef = configuredCompareRef ?? resolved.defaultBaseBranch;
	} else {
		try {
			resolved.defaultCompareRef = configuredCompareRef === undefined
				? await git.detectDefaultCompareRef(compareRefBasePath, resolved.defaultBaseBranch)
				: configuredCompareRef === resolved.defaultBaseBranch
					? configuredCompareRef
					: await git.resolveConfiguredCompareRef(compareRefBasePath, resolved.defaultBaseBranch, configuredCompareRef);
		} catch (err) {
			log.warn("Failed to detect default compare ref, falling back to base branch", {
				path: compareRefBasePath,
				error: String(err),
			});
			resolved.defaultCompareRef = configuredCompareRef ?? resolved.defaultBaseBranch;
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
	// `useRepoConfig: false` removes the file layers entirely: the cascade is the
	// Project object then DEFAULTS, and no .dev3 file is even opened.
	const layers = repoConfigEnabled(project) ? pathConfigLayers(basePath) : [];
	return applyConfigCascade(project, layers, basePath);
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
 * Per field, the highest layer that sets it wins (empty arrays = "not set", bar
 * `clonePaths: []`). The
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
	// The same layers `dev3 config show|set` name, so provenance cannot drift from
	// what a launch reads. Compare-ref auto-detection uses the worktree dir.
	const inWorktree = !!worktreePath && worktreePath !== project.path;
	return applyConfigCascade(project, listConfigLayers(project, worktreePath, opts), inWorktree ? worktreePath! : project.path);
}

/** Per-key-merged project env for a terminal or task session, re-read at launch
 *  time so config-file edits apply on the next launch. Never throws.
 *  Pass the task's `foreignCode` so a reviewed branch cannot export env into
 *  every session it touches (see {@link resolveOperationalProjectConfig}).
 *  Keys the project leaves unset come from the global `agentEnvDefaults`. */
export async function resolveProjectEnv(
	project: Project,
	worktreePath?: string | null,
	opts?: { foreignCode?: boolean },
): Promise<Record<string, string>> {
	const resolved = await resolveOperationalProjectConfig(project, worktreePath ?? undefined, opts);
	return applyAgentEnvDefaults(resolved.env ?? {}, await loadAgentEnvDefaults(), project, homedir(), (dir) =>
		projectClaudeConfigDirAllowed(project, dir),
	);
}

async function loadAgentEnvDefaults(): Promise<Record<string, string> | undefined> {
	try {
		return (await loadSettings()).agentEnvDefaults;
	} catch (err) {
		log.warn("Failed to read agent env defaults", { error: String(err) });
		return undefined;
	}
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

	// Off means dev3 writes no repo file at all — least of all one it would then
	// refuse to read. This runs on every project load, so it is also what keeps a
	// disabled project from growing a .dev3/config.json behind the user's back.
	if (!repoConfigEnabled(project)) return;

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
		if (field !== "env" && local && effective(local[field], field) !== undefined) localPatch[key] = value;
		else if (field !== "env" && repo && effective(repo[field], field) !== undefined) repoPatch[key] = value;
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

// ---- `dev3 config` support: named layers, provenance, validated edits ----

/**
 * A config file in the cascade, named the way `dev3 config` prints it:
 * `local` / `repo` are the files of the checkout being resolved (the task
 * worktree, or the project root outside one); `main-local` / `main-repo` are
 * the project root's files as seen from a worktree.
 */
export type ConfigLayerId = "local" | "repo" | "main-local" | "main-repo";

export interface NamedConfigLayer {
	id: ConfigLayerId;
	path: string;
	exists: boolean;
	/** False for a foreign-code worktree: its command-bearing keys never apply. */
	trusted: boolean;
	config: Dev3RepoConfig | null;
}

/** The layers {@link resolveOperationalProjectConfig} reads, highest first. Empty when repo config is off. */
export function listConfigLayers(project: Project, worktreePath?: string, opts?: { foreignCode?: boolean }): NamedConfigLayer[] {
	if (!repoConfigEnabled(project)) return [];
	const layer = (id: ConfigLayerId, path: string, trusted: boolean): NamedConfigLayer => ({
		id, path, exists: existsSync(path), trusted, config: readJsonFile<Dev3RepoConfig>(path),
	});
	const inWorktree = !!worktreePath && worktreePath !== project.path;
	const base = inWorktree ? worktreePath! : project.path;
	const trusted = !(inWorktree && opts?.foreignCode === true);
	const layers = [
		layer("local", `${base}/${LOCAL_CONFIG_FILE}`, trusted),
		layer("repo", `${base}/${CONFIG_FILE}`, trusted),
	];
	if (inWorktree) {
		layers.push(
			layer("main-local", `${project.path}/${LOCAL_CONFIG_FILE}`, true),
			layer("main-repo", `${project.path}/${CONFIG_FILE}`, true),
		);
	}
	return layers;
}

/**
 * Where each key's effective value came from, mirroring applyConfigCascade:
 * the first layer allowed to supply it, then `project` (projects.json), then
 * `default`, then `unset`. `env` reports its highest contributing layer; the
 * per-variable origin is in `envSources`.
 */
export function resolveLayeredProvenance(
	resolved: Project,
	project: Project,
	layers: NamedConfigLayer[],
): { sources: Record<string, ResolvedConfigSource>; envSources: Record<string, ResolvedConfigSource> } {
	const sources: Record<string, ResolvedConfigSource> = {};
	for (const key of DEV3_REPO_CONFIG_KEYS) {
		const hit = layers.find((l) => layerValue(l, key) !== undefined);
		if (hit) sources[key] = hit.id;
		else if ((project as any)[key] != null) sources[key] = "project";
		else if ((resolved as any)[key] != null) sources[key] = "default";
		else sources[key] = "unset";
	}
	const envSources: Record<string, ResolvedConfigSource> = {};
	for (const name of Object.keys(resolved.env ?? {})) {
		const hit = layers.find((l) => {
			const env = layerValue(l, "env") as Record<string, unknown> | undefined;
			return env !== undefined && Object.prototype.hasOwnProperty.call(env, name);
		});
		envSources[name] = hit ? hit.id : "project";
	}
	return { sources, envSources };
}

export interface ConfigEditResult {
	file: string;
	previous: unknown;
	value: unknown;
	/** A higher layer that still decides the effective value, if any. */
	shadowedBy?: ConfigLayerId;
	/** True when the target is a foreign-code worktree and the key carries a command. */
	ignoredAsForeign?: boolean;
}

export class ConfigEditError extends Error {}

/**
 * Set (or with `value === undefined`, remove) one key, or one entry of a record
 * key, in a single config file. The whole resulting file is validated first and
 * nothing is written when it has errors; the file keeps its own formatting.
 */
export function editConfigFile(
	filePath: string,
	key: keyof Dev3RepoConfig,
	sub: string | undefined,
	value: unknown,
): { previous: unknown; value: unknown } {
	let text = "";
	let current: Record<string, unknown> = {};
	if (existsSync(filePath)) {
		text = readFileSync(filePath, "utf-8");
		if (text.trim()) {
			try {
				current = JSON.parse(text);
			} catch (err) {
				throw new ConfigEditError(`${filePath} is not valid JSON (${(err as Error).message}). Fix it by hand first; dev3 will not overwrite it.`);
			}
			if (current === null || typeof current !== "object" || Array.isArray(current)) {
				throw new ConfigEditError(`${filePath} must hold a JSON object.`);
			}
		}
	}
	const migrated = migrateConfig(current);
	const next = { ...migrated.config };
	const previousField = next[key];
	const previous = sub === undefined
		? previousField
		: (previousField && typeof previousField === "object" ? (previousField as Record<string, unknown>)[sub] : undefined);

	let fieldValue: unknown;
	if (sub === undefined) {
		fieldValue = value;
	} else {
		const entries = previousField && typeof previousField === "object" && !Array.isArray(previousField)
			? { ...(previousField as Record<string, unknown>) }
			: {};
		if (value === undefined) delete entries[sub];
		else entries[sub] = value;
		fieldValue = Object.keys(entries).length > 0 ? entries : undefined;
	}
	if (fieldValue === undefined) delete next[key];
	else next[key] = fieldValue;

	const { errors } = validateConfigFile(next);
	if (errors.length > 0) {
		const lines = errors.map((e) => `  ${e.path || "(file)"}: ${e.message}`).join("\n");
		throw new ConfigEditError(`Not written: ${filePath} would be invalid:\n${lines}`);
	}
	// A migrated file is rewritten whole (every migrated key changed); otherwise
	// only the edited member's text moves.
	const out = migrated.migrated || !text.trim()
		? editJsonMember("", key, fieldValue, next)
		: editJsonMember(text, key, fieldValue, next);
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, out);
	log.info("Edited config file", { path: filePath, key, sub });
	return { previous, value };
}

/** Config file path for a checkout: `.dev3/config.local.json` when `local`, else `.dev3/config.json`. */
export function configFilePath(basePath: string, local: boolean): string {
	return `${basePath}/${local ? LOCAL_CONFIG_FILE : CONFIG_FILE}`;
}

/**
 * Whether a value just written to `file` decides the effective config: the
 * first higher layer that still sets the key (or the record entry) shadows it,
 * and a foreign-code worktree's command-bearing keys never apply.
 */
export function describeEditReach(
	layers: NamedConfigLayer[],
	file: string,
	key: keyof Dev3RepoConfig,
	sub?: string,
): { shadowedBy?: ConfigLayerId; ignoredAsForeign: boolean } {
	const index = layers.findIndex((l) => l.path === file);
	const higher = index === -1 ? [] : layers.slice(0, index);
	const shadow = higher.find((l) => {
		const v = layerValue(l, key);
		if (v === undefined) return false;
		if (sub === undefined || key !== "env") return true;
		return Object.prototype.hasOwnProperty.call(v, sub);
	});
	return {
		shadowedBy: shadow?.id,
		ignoredAsForeign: index !== -1 && !layers[index].trusted && COMMAND_BEARING_KEYS.has(key),
	};
}
