import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Dev3Marker } from "../shared/types";

const HOME = process.env.HOME || "/tmp";
const DEV3_HOME = `${HOME}/.dev3.0`;
const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const WORKTREES_DIR = `${DEV3_HOME}/worktrees`;
const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;

export interface CliContext {
	projectId: string;
	taskId: string;
	socketPath: string;
}

/**
 * Walk up from cwd to find .dev3-marker and resolve project/task context.
 */
function detectFromMarker(cwd: string): CliContext | null {
	let dir = cwd;
	for (let i = 0; i < 30; i++) {
		const markerPath = `${dir}/.dev3-marker`;
		if (existsSync(markerPath)) {
			try {
				const marker: Dev3Marker = JSON.parse(readFileSync(markerPath, "utf-8"));
				return {
					projectId: marker.projectId,
					taskId: marker.taskId,
					socketPath: marker.socketPath,
				};
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Parse worktree path to extract project slug and task short ID.
 * Path pattern: ~/.dev3.0/worktrees/{projectSlug}/{taskShortId}/worktree
 */
function detectFromWorktreePath(cwd: string): { projectSlug: string; taskShortId: string } | null {
	// Normalize: walk up to find "worktree" directory under WORKTREES_DIR
	const prefix = `${WORKTREES_DIR}/`;
	let dir = cwd;
	for (let i = 0; i < 30; i++) {
		if (dir.startsWith(prefix)) {
			const relative = dir.slice(prefix.length);
			// relative should be: {projectSlug}/{taskShortId}/worktree[/...]
			const parts = relative.split("/");
			if (parts.length >= 3 && parts[2] === "worktree") {
				return { projectSlug: parts[0], taskShortId: parts[1] };
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Resolve project and task IDs from worktree path by reading data files directly.
 */
function resolveFromWorktreePath(cwd: string): CliContext | null {
	const pathInfo = detectFromWorktreePath(cwd);
	if (!pathInfo) return null;

	// Find the project by slug match
	try {
		const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")) as Array<{ id: string; path: string }>;
		const project = projects.find((p) => {
			const slug = p.path.replace(/^\//, "").replaceAll("/", "-");
			return slug === pathInfo.projectSlug;
		});
		if (!project) return null;

		// Find the task by short ID prefix
		const taskDataDir = `${DEV3_HOME}/data/${pathInfo.projectSlug}`;
		const tasksFile = `${taskDataDir}/tasks.json`;
		if (!existsSync(tasksFile)) return null;

		const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
		const task = tasks.find((t) => t.id.startsWith(pathInfo.taskShortId));
		if (!task) return null;

		// Try to find a live socket
		const socketPath = discoverSocket() || "";

		return {
			projectId: project.id,
			taskId: task.id,
			socketPath,
		};
	} catch {
		return null;
	}
}

/**
 * Detect context: marker file first, then worktree path fallback.
 */
export function detectContext(cwd: string = process.cwd()): CliContext | null {
	return detectFromMarker(cwd) || resolveFromWorktreePath(cwd);
}

/**
 * Find any live socket in ~/.dev3.0/sockets/ (for commands without worktree context).
 */
export function discoverSocket(): string | null {
	if (!existsSync(SOCKETS_DIR)) return null;

	for (const file of readdirSync(SOCKETS_DIR)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
		if (isNaN(pid)) continue;

		try {
			process.kill(pid, 0); // Check if alive
			return `${SOCKETS_DIR}/${file}`;
		} catch {
			// Dead process, skip
		}
	}
	return null;
}

/**
 * Get socket path: from context (preferred) or by discovery.
 */
export function resolveSocketPath(cwd?: string): string | null {
	const ctx = detectContext(cwd);
	if (ctx?.socketPath && existsSync(ctx.socketPath)) {
		return ctx.socketPath;
	}
	return discoverSocket();
}

/**
 * Read project info directly from data files (no socket needed).
 */
export function readProjectDirect(projectId: string): { id: string; name: string; path: string } | null {
	try {
		const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")) as Array<{ id: string; name: string; path: string }>;
		return projects.find((p) => p.id === projectId || p.id.startsWith(projectId)) || null;
	} catch {
		return null;
	}
}

/**
 * Read task info directly from data files (no socket needed).
 */
export function readTaskDirect(projectId: string, taskId: string): Record<string, unknown> | null {
	try {
		const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")) as Array<{ id: string; path: string }>;
		const project = projects.find((p) => p.id === projectId);
		if (!project) return null;

		const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
		const tasksFile = `${DEV3_HOME}/data/${slug}/tasks.json`;
		if (!existsSync(tasksFile)) return null;

		const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<Record<string, unknown>>;
		return tasks.find((t) => t.id === taskId || (t.id as string).startsWith(taskId)) || null;
	} catch {
		return null;
	}
}
