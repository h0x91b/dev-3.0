import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { Project, ProjectFolder } from "../shared/types";
import { run as runGit } from "./git";
import * as repoConfig from "./repo-config";
import { createLogger } from "./logger";

/**
 * Folders shown beside a project: its `extraFolders` config field plus Claude's
 * `permissions.additionalDirectories` from the project's own Claude settings.
 * See decisions/2026/11/15/project-extra-folders.md.
 */

const log = createLogger("project-folders");
const BRANCH_TIMEOUT_MS = 3000;

function expandPath(raw: string, base: string): string {
	const trimmed = raw.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(base, trimmed);
}

/** Project-scope Claude settings, plus the config dir the project pins through `env.CLAUDE_CONFIG_DIR`. */
export function claudeSettingsFiles(projectPath: string, configDir?: string): string[] {
	const files = [join(projectPath, ".claude", "settings.json"), join(projectPath, ".claude", "settings.local.json")];
	if (configDir) {
		const dir = expandPath(configDir, projectPath);
		files.push(join(dir, "settings.json"), join(dir, "settings.local.json"));
	}
	return [...new Set(files)];
}

function displayPath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

async function readAdditionalDirectories(file: string): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(file, "utf-8");
	} catch {
		return [];
	}
	try {
		const dirs = JSON.parse(text)?.permissions?.additionalDirectories;
		return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === "string" && d.trim() !== "") : [];
	} catch (err) {
		log.warn("Unreadable Claude settings file", { file, error: String(err) });
		return [];
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function currentBranch(path: string): Promise<string | undefined> {
	const result = await runGit(["git", "rev-parse", "--abbrev-ref", "HEAD"], path, { timeoutMs: BRANCH_TIMEOUT_MS }).catch(() => null);
	const branch = result?.ok ? result.stdout.trim() : "";
	return branch && branch !== "HEAD" ? branch : undefined;
}

/** `project` must already be resolved through the config cascade. */
export async function collectProjectFolders(project: Project, opts: { withBranch?: boolean } = {}): Promise<ProjectFolder[]> {
	if (project.kind === "virtual" || !project.path) return [];
	const own = expandPath(project.path, project.path);
	const seen = new Set<string>([own]);
	const candidates: { path: string; source: ProjectFolder["source"] }[] = [];
	const add = (raw: string, source: ProjectFolder["source"]) => {
		const path = expandPath(raw, project.path);
		if (seen.has(path)) return;
		seen.add(path);
		candidates.push({ path, source });
	};
	for (const raw of project.extraFolders ?? []) if (raw.trim()) add(raw, "dev3");
	for (const file of claudeSettingsFiles(project.path, project.env?.CLAUDE_CONFIG_DIR)) {
		for (const raw of await readAdditionalDirectories(file)) add(raw, "claude");
	}
	return Promise.all(candidates.map(async ({ path, source }) => {
		const exists = await isDirectory(path);
		const branch = opts.withBranch && exists ? await currentBranch(path) : undefined;
		return { path, displayPath: displayPath(path), name: basename(path) || path, source, exists, ...(branch ? { branch } : {}) };
	}));
}

export async function resolveProjectFolders(project: Project, opts: { withBranch?: boolean } = {}): Promise<ProjectFolder[]> {
	if (project.kind === "virtual" || !project.path) return [];
	return collectProjectFolders(await repoConfig.resolveProjectConfig(project), opts);
}
