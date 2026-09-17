import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { Utils } from "../electrobun-platform";
import type { FilePreviewResult, ResolvedTerminalPath } from "../../shared/types";
import * as data from "../data";
import { run as runGit } from "../git";
import { spawn } from "../spawn";
import { log } from "./shared";

/**
 * Backend for Cmd/Ctrl+Click file-path links in terminal output: resolve
 * regex-detected candidates against the task worktree / project directory,
 * open them per the user's setting, and feed the in-app preview modal.
 *
 * A relative candidate that does not exist under a base is looked up a second
 * time as a path SUFFIX in that base's git file index, so the way agents
 * actually name files in prose ("architecture.md" for `docs/architecture.md`)
 * becomes a link. Only a unique match counts — see
 * decisions/2026/08/24/terminal-links-unique-suffix-fallback.md.
 *
 * All three handlers take client-supplied paths, so every path they touch is
 * gated to {@link allowedRoots} — the home directory, the OS temp directories
 * and registered project roots. Resolution is gated too: an out-of-scope path
 * must never become a link that then refuses to open, and `..` segments let
 * even a relative candidate escape its base. Same exposure class as
 * `listDirectory` behind the same auth, but bounded — see
 * decisions/2026/08/06/terminal-file-path-links.md.
 */

const RESOLVE_TERMINAL_PATHS_MAX = 64;
const TERMINAL_PATH_MAX_LEN = 1024;
const FILE_PREVIEW_MAX_TEXT_BYTES = 256 * 1024;
const FILE_PREVIEW_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const PREVIEW_IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
};

async function statPathKind(absPath: string, roots: string[]): Promise<ResolvedTerminalPath | null> {
	if (!isPathAllowed(absPath, roots)) return null;
	try {
		const st = await stat(absPath);
		if (st.isFile()) return { path: absPath, kind: "file" };
		if (st.isDirectory()) return { path: absPath, kind: "directory" };
	} catch {
		// ENOENT / EACCES → not linkable
	}
	return null;
}

async function projectRoots(): Promise<string[]> {
	try {
		const projects = await data.loadProjects();
		return projects.filter((p) => p.kind !== "virtual" && p.path).map((p) => p.path);
	} catch {
		return [];
	}
}

function isUnder(absPath: string, root: string): boolean {
	return absPath === root || absPath.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * Agents park screenshots and scratch output in the OS temp directory, and both
 * it and `/tmp` have a second spelling on macOS (`/private/...`), which the
 * string-prefix gate would not otherwise recognise as the same place. A root of
 * `/` would make the gate admit the whole filesystem, so a degenerate `TMPDIR`
 * is dropped rather than trusted.
 */
function computeTempRoots(): string[] {
	const roots = new Set<string>();
	const add = (root: string) => {
		if (!root || root === "/") return;
		roots.add(root);
		try {
			roots.add(realpathSync(root));
		} catch {
			// no such directory on this system
		}
	};
	add(tmpdir());
	if (process.platform !== "win32") add("/tmp");
	return [...roots];
}

// Constant for the process lifetime, and `realpathSync` is sync — resolve once.
let cachedTempRoots: string[] | null = null;
function tempRoots(): string[] {
	cachedTempRoots ??= computeTempRoots();
	return cachedTempRoots;
}

async function allowedRoots(): Promise<string[]> {
	return [homedir(), ...tempRoots(), ...(await projectRoots())];
}

/**
 * The gate compares path strings and deliberately does not resolve symlinks —
 * see decisions/2026/08/06/terminal-file-path-links.md. The temp directories are
 * the one exception: they are world-writable, so a symlink planted there by any
 * local account could aim at a file no root covers, and only following it before
 * the stat tells the two apart.
 */
function isPathAllowed(absPath: string, roots: string[]): boolean {
	if (!roots.some((root) => isUnder(absPath, root))) return false;
	if (!tempRoots().some((root) => isUnder(absPath, root))) return true;
	try {
		return roots.some((root) => isUnder(realpathSync(absPath), root));
	} catch {
		// Unreadable or dangling: nothing to open either way.
		return false;
	}
}

async function isTerminalPathAllowed(absPath: string): Promise<boolean> {
	return isPathAllowed(resolvePath(absPath), await allowedRoots());
}

async function terminalPathBases(params: { taskId?: string; projectId?: string }): Promise<string[]> {
	const bases: string[] = [];
	if (!params.projectId) return bases;
	try {
		const project = await data.getProject(params.projectId);
		if (params.taskId) {
			// The project terminal reuses TerminalView with a session key here,
			// not a real task id — a failed lookup still keeps the project base.
			try {
				const task = await data.getTask(project, params.taskId);
				if (task.worktreePath) bases.push(task.worktreePath);
			} catch {
				// not a task — project base only
			}
		}
		if (project.kind !== "virtual" && project.path) bases.push(project.path);
	} catch (err) {
		log.warn("terminalPathBases: lookup failed", { error: String(err) });
	}
	return bases;
}

const FILE_INDEX_TTL_MS = 15_000;
const FILE_INDEX_LIST_TIMEOUT_MS = 3_000;
// Above this a "unique" suffix match stops being trustworthy to compute cheaply,
// so the whole index is dropped and the base keeps plain relative resolution.
const FILE_INDEX_MAX_FILES = 50_000;

/** Repo-relative paths grouped by basename; `null` = too many to disambiguate. */
type FileIndex = Map<string, string[] | null> | null;
const FILE_INDEX_MAX_PER_BASENAME = 16;

const fileIndexCache = new Map<string, { at: number; index: FileIndex }>();

/**
 * Every file git knows about under `base` (tracked plus untracked-not-ignored),
 * grouped by basename. Cheap enough to rebuild on a TTL — one `git ls-files`
 * per base per 15s, regardless of how many candidates ask for it.
 */
async function fileIndexFor(base: string): Promise<FileIndex> {
	const hit = fileIndexCache.get(base);
	if (hit && Date.now() - hit.at < FILE_INDEX_TTL_MS) return hit.index;
	const index = await buildFileIndex(base);
	fileIndexCache.set(base, { at: Date.now(), index });
	return index;
}

async function buildFileIndex(base: string): Promise<FileIndex> {
	const result = await runGit(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], base, {
		timeoutMs: FILE_INDEX_LIST_TIMEOUT_MS,
	});
	if (!result.ok) return null;
	const paths = result.stdout.split("\0").filter(Boolean);
	if (paths.length > FILE_INDEX_MAX_FILES) {
		log.warn("terminal-paths: file index skipped, repo too large", { base, files: paths.length });
		return null;
	}
	const index: NonNullable<FileIndex> = new Map();
	for (const path of paths) {
		const basename = path.slice(path.lastIndexOf("/") + 1);
		const known = index.get(basename);
		if (known === null) continue;
		if (!known) {
			index.set(basename, [path]);
		} else if (known.length >= FILE_INDEX_MAX_PER_BASENAME) {
			index.set(basename, null);
		} else {
			known.push(path);
		}
	}
	return index;
}

// An explicit relative path ("./x", "../x") states where it lives; only a
// path the output left rooted at nothing gets searched.
const EXPLICITLY_ROOTED = /^\.{1,2}\//;

/**
 * The one file under `base` whose path ends in `candidate` at a segment
 * boundary. Ambiguous matches resolve to nothing: no link beats a link that
 * opens the wrong file.
 */
async function resolveBySuffix(base: string, candidate: string, roots: string[]): Promise<ResolvedTerminalPath | null> {
	if (EXPLICITLY_ROOTED.test(candidate) || candidate.split("/").includes("..")) return null;
	const index = await fileIndexFor(base);
	if (!index) return null;
	const known = index.get(candidate.slice(candidate.lastIndexOf("/") + 1));
	if (!known) return null;
	const matches = known.filter((path) => path === candidate || path.endsWith(`/${candidate}`));
	if (matches.length !== 1) return null;
	return statPathKind(resolvePath(base, matches[0]!), roots);
}

async function resolveTerminalPaths(params: {
	taskId?: string;
	projectId?: string;
	paths: string[];
}): Promise<{ resolved: Record<string, ResolvedTerminalPath | null> }> {
	const resolved: Record<string, ResolvedTerminalPath | null> = {};
	const candidates = params.paths.slice(0, RESOLVE_TERMINAL_PATHS_MAX);
	const bases = await terminalPathBases(params);
	// Hoisted: one projects.json lookup per call, not per candidate.
	const roots = await allowedRoots();
	for (const raw of candidates) {
		resolved[raw] = null;
		if (!raw || raw.length > TERMINAL_PATH_MAX_LEN || raw.includes("\0")) continue;
		const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
		if (isAbsolute(expanded)) {
			resolved[raw] = await statPathKind(resolvePath(expanded), roots);
			continue;
		}
		let hit: ResolvedTerminalPath | null = null;
		for (const base of bases) {
			hit = await statPathKind(resolvePath(base, expanded), roots);
			if (hit) break;
		}
		// Only once every base has been tried as-is: a file that exists where the
		// output said it does must never lose to a suffix match somewhere else.
		for (const base of bases) {
			if (hit) break;
			hit = await resolveBySuffix(base, expanded, roots);
		}
		resolved[raw] = hit;
	}
	return { resolved };
}

async function openTerminalPath(params: { path: string; mode: "system" | "reveal" }): Promise<void> {
	log.info("→ openTerminalPath", { path: params.path, mode: params.mode });
	if (!isAbsolute(params.path) || params.path.includes("\0")) {
		throw new Error("Invalid file path");
	}
	if (!(await isTerminalPathAllowed(params.path))) {
		throw new Error("Path is outside the allowed directories");
	}
	let st: Stats;
	try {
		st = await stat(params.path);
	} catch {
		throw new Error("File not found");
	}
	if (params.mode === "reveal") {
		if (process.platform === "darwin") {
			spawn(["open", "-R", params.path]);
		} else {
			// Linux file managers have no portable "select file"; open the parent dir.
			Utils.openPath(st.isDirectory() ? params.path : dirname(params.path));
		}
		return;
	}
	Utils.openPath(params.path);
}

/** Cut a UTF-8 buffer at a char boundary so truncation never splits a code point. */
function utf8SafeSlice(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	let end = maxBytes;
	// Back off continuation bytes (0b10xxxxxx) to the start of the sequence.
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end);
}

async function readFilePreview(params: { path: string }): Promise<FilePreviewResult> {
	log.info("→ readFilePreview", { path: params.path });
	if (!isAbsolute(params.path) || params.path.includes("\0")) {
		return { kind: "not-found" };
	}
	if (!(await isTerminalPathAllowed(params.path))) {
		return { kind: "not-found" };
	}
	let st: Stats;
	try {
		st = await stat(params.path);
	} catch {
		return { kind: "not-found" };
	}
	if (st.isDirectory()) return { kind: "directory" };
	if (!st.isFile()) return { kind: "not-found" };
	const size = st.size;
	const ext = params.path.split(".").pop()?.toLowerCase() ?? "";
	const imageMime = PREVIEW_IMAGE_MIME[ext];
	if (imageMime) {
		if (size > FILE_PREVIEW_MAX_IMAGE_BYTES) return { kind: "too-large", size };
		const buffer = await readFile(params.path);
		return { kind: "image", dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`, size };
	}
	if (size > FILE_PREVIEW_MAX_TEXT_BYTES * 4) return { kind: "too-large", size };
	const buffer = await readFile(params.path);
	if (buffer.subarray(0, 8192).includes(0)) return { kind: "binary", size };
	const truncated = buffer.length > FILE_PREVIEW_MAX_TEXT_BYTES;
	const content = utf8SafeSlice(buffer, FILE_PREVIEW_MAX_TEXT_BYTES).toString("utf-8");
	return { kind: "text", content, truncated, size };
}

export const terminalPathHandlers = {
	resolveTerminalPaths,
	openTerminalPath,
	readFilePreview,
};
