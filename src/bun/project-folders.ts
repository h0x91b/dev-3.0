import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { launchClaudeConfigLocation } from "../shared/claude-config-dir";
import type { Project, ProjectFolder } from "../shared/types";
import { run as runGit } from "./git";
import * as repoConfig from "./repo-config";
import { createLogger } from "./logger";

/**
 * Folders shown beside a project: its `extraFolders` config field plus Claude's
 * `permissions.additionalDirectories` from the project's and the user's Claude settings,
 * plus the folders of any VS Code `*.code-workspace` file in the project root.
 * See decisions/2026/11/15/project-extra-folders.md.
 */

const log = createLogger("project-folders");
const BRANCH_TIMEOUT_MS = 3000;
/** The explorer re-lists open folders every 10s and each listing re-checks the folder; this keeps that off the config cascade. */
const CACHE_TTL_MS = 5000;
/** git must never pick up a repository a committed folder smuggles in: no bare-repo discovery, no fsmonitor hook. */
export const SAFE_GIT_ARGS = ["-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false"];

/** A network path is opened by `stat` alone, which on Windows sends the user's credentials to that host. */
function isNetworkPath(raw: string): boolean {
	const trimmed = raw.trim();
	return trimmed.startsWith("\\\\") || trimmed.startsWith("//");
}

function expandPath(raw: string, base: string): string {
	const trimmed = raw.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(base, trimmed);
}

/**
 * The user-scope Claude config dir a project's agents read. `project.env` must be the launch env
 * (`resolveProjectEnv`, global agent env defaults included): the server's own `CLAUDE_CONFIG_DIR`
 * counts only when the launch sets none, since that is the only case an agent inherits it.
 */
export function claudeConfigDirFor(project: Pick<Project, "env" | "path">): string {
	return launchClaudeConfigLocation(project.env, process.env, homedir(), project.path).dir;
}

/** Project-scope Claude settings, plus the user-scope ones in `configDir`. */
export function claudeSettingsFiles(projectPath: string, configDir?: string): string[] {
	const files = [join(projectPath, ".claude", "settings.json"), join(projectPath, ".claude", "settings.local.json")];
	if (configDir && !isNetworkPath(configDir)) {
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

/** Index of the quote that closes the string opening at `start`, or the text length when it never closes. */
function stringEnd(text: string, start: number): number {
	let j = start + 1;
	while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return j;
}

/** Comments and trailing commas out, strings untouched: `.code-workspace` files are JSONC. */
export function stripJsonc(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			const j = stringEnd(text, i);
			out += text.slice(i, j + 1);
			i = j;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 1;
		} else {
			out += ch;
		}
	}
	// A second pass, so a comment between a trailing comma and its bracket is already gone.
	let result = "";
	for (let i = 0; i < out.length; i++) {
		const ch = out[i];
		if (ch === '"') {
			const j = stringEnd(out, i);
			result += out.slice(i, j + 1);
			i = j;
		} else if (ch === ",") {
			let k = i + 1;
			while (k < out.length && /\s/.test(out[k])) k++;
			if (out[k] !== "}" && out[k] !== "]") result += ch;
		} else {
			result += ch;
		}
	}
	return result;
}

/** A Windows drive path means nothing to a server on another OS (a workspace file shared with Windows VS Code). */
const FOREIGN_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** A `file://host/share` URI is a network path: on POSIX it throws, on Windows it becomes a UNC path and is dropped later. */
function fileUrlPath(uri: string): string | undefined {
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

/** Folder paths from every `*.code-workspace` file in the project root; `.` is the project itself and drops out later. */
export async function readWorkspaceFolders(projectPath: string): Promise<string[]> {
	const names = await readdir(projectPath).catch(() => [] as string[]);
	const folders: string[] = [];
	for (const name of names.filter((n) => n.endsWith(".code-workspace")).sort()) {
		const file = join(projectPath, name);
		try {
			const parsed = JSON.parse(stripJsonc(await readFile(file, "utf-8")));
			for (const folder of Array.isArray(parsed?.folders) ? parsed.folders : []) {
				let path: string | undefined;
				if (typeof folder?.path === "string") path = folder.path;
				else if (typeof folder?.uri === "string" && folder.uri.startsWith("file:")) path = fileUrlPath(folder.uri);
				if (!path?.trim() || (process.platform !== "win32" && FOREIGN_DRIVE_PATH.test(path))) continue;
				folders.push(path);
			}
		} catch (err) {
			log.warn("Unreadable VS Code workspace file", { file, error: String(err) });
		}
	}
	return folders;
}

/** The path with symlinks resolved; a missing path keeps its text form. */
async function realPathOr(path: string): Promise<string> {
	return realpath(path).catch(() => path);
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function currentBranch(path: string): Promise<string | undefined> {
	const result = await runGit(["git", ...SAFE_GIT_ARGS, "rev-parse", "--abbrev-ref", "HEAD"], path, { timeoutMs: BRANCH_TIMEOUT_MS }).catch(() => null);
	const branch = result?.ok ? result.stdout.trim() : "";
	return branch && branch !== "HEAD" ? branch : undefined;
}

/** `project` must already be resolved through the config cascade, with `env` set to its launch env. */
export async function collectProjectFolders(project: Project, opts: { withBranch?: boolean } = {}): Promise<ProjectFolder[]> {
	if (project.kind === "virtual" || !project.path) return [];
	// Compared by real path, so a symlink into the project or to a listed folder adds no second tree.
	const own = await realPathOr(expandPath(project.path, project.path));
	const seen = new Set<string>([own]);
	const candidates: { path: string; source: ProjectFolder["source"] }[] = [];
	const add = async (raw: string, source: ProjectFolder["source"]) => {
		if (isNetworkPath(raw)) {
			log.warn("Skipping a network path in the project's extra folders", { source });
			return;
		}
		const path = expandPath(raw, project.path);
		const real = await realPathOr(path);
		// A folder inside the project is already in its tree. A folder that contains the project stays: it is a wider grant worth seeing.
		if (seen.has(real) || real.startsWith(own + sep)) return;
		seen.add(real);
		candidates.push({ path, source });
	};
	for (const raw of project.extraFolders ?? []) if (raw.trim()) await add(raw, "dev3");
	for (const file of claudeSettingsFiles(project.path, claudeConfigDirFor(project))) {
		for (const raw of await readAdditionalDirectories(file)) await add(raw, "claude");
	}
	for (const raw of await readWorkspaceFolders(project.path)) await add(raw, "vscode");
	return Promise.all(candidates.map(async ({ path, source }) => {
		const exists = await isDirectory(path);
		const branch = opts.withBranch && exists ? await currentBranch(path) : undefined;
		return { path, displayPath: displayPath(path), name: basename(path) || path, source, exists, ...(branch ? { branch } : {}) };
	}));
}

const cache = new Map<string, { at: number; folders: Promise<ProjectFolder[]> }>();

export async function resolveProjectFolders(project: Project, opts: { withBranch?: boolean } = {}): Promise<ProjectFolder[]> {
	if (project.kind === "virtual" || !project.path) return [];
	const key = `${project.id}:${opts.withBranch ? 1 : 0}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.folders;
	const folders = Promise.all([repoConfig.resolveProjectConfig(project), repoConfig.resolveProjectEnv(project, project.path)]).then(
		([resolved, env]) => collectProjectFolders({ ...resolved, env }, opts),
	);
	cache.set(key, { at: Date.now(), folders });
	folders.catch(() => cache.delete(key));
	return folders;
}

/** Tests and settings saves start from a fresh read. */
export function clearProjectFoldersCache(projectId?: string): void {
	for (const key of cache.keys()) if (!projectId || key.startsWith(`${projectId}:`)) cache.delete(key);
}
