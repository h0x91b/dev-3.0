import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { Utils } from "../electrobun-platform";
import type { FilePreviewResult, ResolvedTerminalPath } from "../../shared/types";
import * as data from "../data";
import { spawn } from "../spawn";
import { log } from "./shared";

/**
 * Backend for Cmd/Ctrl+Click file-path links in terminal output: resolve
 * regex-detected candidates against the task worktree / project directory,
 * open them per the user's setting, and feed the in-app preview modal.
 *
 * All three handlers take client-supplied paths, so every path they touch is
 * gated to {@link allowedRoots} — the home directory plus registered project
 * roots. Resolution is gated too: an out-of-scope path must never become a
 * link that then refuses to open, and `..` segments let even a relative
 * candidate escape its base. Same exposure class as `listDirectory` behind
 * the same auth, but bounded — see decisions/2026/08/06/terminal-file-path-links.md.
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
	if (!roots.some((root) => isUnder(absPath, root))) return null;
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

async function allowedRoots(): Promise<string[]> {
	return [homedir(), ...(await projectRoots())];
}

async function isTerminalPathAllowed(absPath: string): Promise<boolean> {
	const normalized = resolvePath(absPath);
	return (await allowedRoots()).some((root) => isUnder(normalized, root));
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
		for (const base of bases) {
			const hit = await statPathKind(resolvePath(base, expanded), roots);
			if (hit) {
				resolved[raw] = hit;
				break;
			}
		}
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
