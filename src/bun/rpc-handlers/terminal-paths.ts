import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { Utils } from "../electrobun-platform";
import { DOWNLOAD_TTL_MS, gitIgnoreVerdict, mintFileLink } from "../file-links";
import { DEV3_HOME } from "../paths";
import { isWslHost, openOnWindowsHost } from "../wsl-host";
import { FILE_LINK_PAGE_EXTS, WINDOWS_OPEN_SAFE_EXTS, fileLinkExt } from "../../shared/file-link-types";
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

/** `separator` is the host's (a backslash on Windows); a parameter only so tests can cover both. */
export function isUnder(absPath: string, root: string, separator: string = sep): boolean {
	return absPath === root || absPath.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
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

/** The previewable file at `path`, or an Error naming why it cannot be handed over. */
async function assertPreviewableFile(path: string): Promise<void> {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid file path");
	if (!(await isTerminalPathAllowed(path))) throw new Error("Path is outside the allowed directories");
	let st: Stats;
	try {
		st = await stat(path);
	} catch {
		throw new Error("File not found");
	}
	if (!st.isFile()) throw new Error("Not a file");
}

/** The closest folder at or above `dir` holding a `.git` entry (a checkout root), or null. */
async function nearestCheckout(dir: string): Promise<string | null> {
	for (let current = dir; ; current = dirname(current)) {
		try {
			await stat(join(current, ".git"));
			return current;
		} catch {
			if (dirname(current) === current) return null;
		}
	}
}

function realOr(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

/**
 * Only a page (HTML/SVG) strictly inside a task worktree or project checkout gets
 * its folder, so its relative assets load; returns that checkout, or null for a
 * one-file link. Decided on the real folder the link then pins as-is, never inside
 * a dot-folder of the checkout (`.git/`), never at a checkout root, never in dev3's
 * own storage, and never through a symlink into a different checkout.
 */
async function folderLinkCheckout(requested: string, realFile: string): Promise<string | null> {
	if (!FILE_LINK_PAGE_EXTS.has(fileLinkExt(realFile))) return null;
	const dir = dirname(realFile);
	const checkout = await nearestCheckout(dir);
	if (!checkout || checkout === dir) return null;
	if (relative(checkout, dir).split(sep).some((part) => part.startsWith("."))) return null;
	const requestedCheckout = await nearestCheckout(dirname(requested));
	if (!requestedCheckout || realOr(requestedCheckout) !== checkout) return null;
	const worktreesRoot = realOr(join(DEV3_HOME, "worktrees"));
	// A checkout that contains dev3's storage (a dotfiles repo at ~) is not a task's checkout.
	if (isUnder(worktreesRoot, checkout)) return null;
	const inScope = isUnder(checkout, worktreesRoot) || (await projectRoots()).some((root) => isUnder(checkout, realOr(root)));
	return inScope ? checkout : null;
}

function absolutePath(raw: string): string {
	if (!isAbsolute(raw) || raw.includes("\0")) throw new Error("Invalid file path");
	return resolvePath(raw);
}

/** One link per click: a 12 h view link (folder-scoped for a page), or a 60 s single-file download link. */
async function createFileLink(params: { path: string; download?: boolean }): Promise<{ url: string }> {
	log.info("→ createFileLink", { path: params.path, download: !!params.download });
	const path = absolutePath(params.path);
	await assertPreviewableFile(path);
	// Resolved once: the folder decision and the pinned scope must be the same path.
	const realFile = realpathSync.native(path);
	if (params.download) return { url: `${mintFileLink({ kind: "file", path: realFile }, { ttlMs: DOWNLOAD_TTL_MS, resolved: true })}?download=1` };
	const checkout = await folderLinkCheckout(path, realFile);
	if (!checkout) return { url: mintFileLink({ kind: "file", path: realFile }, { resolved: true }) };
	// Ignored files stay out, except page assets (CSS, scripts, images…) the page's own ignore rule covers.
	const page = await gitIgnoreVerdict(checkout, realFile);
	const ignore = { checkout, pageRule: page.state === "ignored" ? page.rule : null };
	return { url: mintFileLink({ kind: "dir", root: dirname(realFile), entry: basename(realFile), ignore }, { resolved: true }) };
}

/** Whether this server can open files on the Windows desktop it runs under (WSL interop). */
async function getWindowsHostOpen(): Promise<{ available: boolean }> {
	return { available: isWslHost() };
}

async function openFileOnWindowsHost(params: { path: string }): Promise<void> {
	log.info("→ openFileOnWindowsHost", { path: params.path });
	if (!isWslHost()) throw new Error("Not running under WSL");
	const path = absolutePath(params.path);
	await assertPreviewableFile(path);
	// Both the name and its real target: a `report.html` symlink to a `.hta` must not pass.
	const real = realpathSync.native(path);
	if (![path, real].every((p) => WINDOWS_OPEN_SAFE_EXTS.has(fileLinkExt(p)))) throw new Error("This file type is not opened on Windows");
	// WSLENV `/p` treats `:` as a list separator, so the path would arrive as a different file.
	if (real.includes(":")) throw new Error("This file name cannot be opened on Windows");
	await openOnWindowsHost(real);
}

export const terminalPathHandlers = {
	resolveTerminalPaths,
	openTerminalPath,
	readFilePreview,
	createFileLink,
	getWindowsHostOpen,
	openFileOnWindowsHost,
};
