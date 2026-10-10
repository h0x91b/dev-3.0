import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve as resolvePath, sep } from "node:path";
import { EXPLORER_MAX_ENTRIES, type ExplorerEntry, type ExplorerListing } from "../../shared/types";
import * as data from "../data";
import { run as runGit } from "../git";
import { log } from "./shared";

/**
 * Backend for the file explorer panel: lists one directory level under a fixed
 * root - the task worktree, or the project checkout on the board. The renderer
 * sends only a root-relative path, and anything resolving outside the root is
 * refused. See decisions/2026/10/02/file-explorer-panel.md.
 */

const IGNORED_LOOKUP_TIMEOUT_MS = 5000;
const HIDDEN_NAMES = new Set([".git"]);

async function explorerRoot(projectId: string, taskId?: string | null): Promise<string | null> {
	const project = await data.getProject(projectId);
	if (taskId) {
		const task = await data.getTask(project, taskId);
		return task.worktreePath ?? null;
	}
	if (project.kind === "virtual" || !project.path) return null;
	return project.path;
}

function toPosix(relPath: string): string {
	return sep === "/" ? relPath : relPath.split(sep).join("/");
}

/**
 * Names of the direct children of `relDir` that git ignores. Any failure (not a
 * git repo, timeout) yields an empty set: the tree still lists, just undimmed.
 */
async function ignoredChildren(root: string, relDir: string): Promise<Set<string>> {
	const prefix = relDir ? `${relDir}/` : "";
	const result = await runGit(
		["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", relDir || "."],
		root,
		{ timeoutMs: IGNORED_LOOKUP_TIMEOUT_MS },
	).catch(() => null);
	const names = new Set<string>();
	if (!result?.ok) return names;
	for (const raw of result.stdout.split("\0")) {
		if (!raw.startsWith(prefix)) continue;
		const rest = raw.slice(prefix.length).replace(/\/$/, "");
		if (rest && !rest.includes("/")) names.add(rest);
	}
	return names;
}

function compareEntries(a: ExplorerEntry, b: ExplorerEntry): number {
	if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
	return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

async function listExplorerDirectory(params: {
	projectId: string;
	taskId?: string | null;
	relPath?: string;
}): Promise<ExplorerListing> {
	const requested = (params.relPath ?? "").replace(/^\/+|\/+$/g, "");
	log.info("→ listExplorerDirectory", { taskId: params.taskId?.slice(0, 8), relPath: requested });

	const root = await explorerRoot(params.projectId, params.taskId);
	if (!root) return { root: "", relPath: requested, entries: [], error: "no-root" };

	const absDir = resolvePath(root, requested);
	const relDir = toPosix(relative(root, absDir));
	if (relDir.startsWith("..") || resolvePath(root, relDir) !== absDir) {
		log.warn("listExplorerDirectory: path outside root", { relPath: requested });
		return { root, relPath: requested, entries: [], error: "outside-root" };
	}

	let names: string[];
	try {
		names = await readdir(absDir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return { root, relPath: relDir, entries: [], error: code === "ENOENT" || code === "ENOTDIR" ? "not-found" : "unreadable" };
	}

	const ignored = await ignoredChildren(root, relDir);
	const entries: ExplorerEntry[] = [];
	await Promise.all(
		names.filter((name) => !HIDDEN_NAMES.has(name)).map(async (name) => {
			const path = join(absDir, name);
			try {
				// `stat` follows symlinks, so a linked directory still expands.
				const st = await stat(path);
				entries.push({
					name,
					path,
					relPath: relDir ? `${relDir}/${name}` : name,
					kind: st.isDirectory() ? "directory" : "file",
					ignored: ignored.has(name),
				});
			} catch {
				// Broken symlink or permission denied: nothing to show or open.
			}
		}),
	);
	entries.sort(compareEntries);
	const truncated = entries.length > EXPLORER_MAX_ENTRIES;
	log.info("← listExplorerDirectory", { count: entries.length, truncated });
	return { root, relPath: relDir, entries: truncated ? entries.slice(0, EXPLORER_MAX_ENTRIES) : entries, ...(truncated ? { truncated } : {}) };
}

export const fileExplorerHandlers = {
	listExplorerDirectory,
};
