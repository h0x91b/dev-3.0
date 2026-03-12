import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

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

/** Marker that appears in every dev3 worktree path. */
const WORKTREE_MARKER = "/.dev3.0/worktrees/";

/**
 * Parse worktree path to extract project slug and task short ID.
 * Path pattern: {any-home}/.dev3.0/worktrees/{projectSlug}/{taskShortId}/worktree
 *
 * First tries the HOME-based WORKTREES_DIR prefix. If that fails (e.g. Codex
 * sandbox rewrites HOME=/tmp while cwd still uses the real home), falls back
 * to searching for the `/.dev3.0/worktrees/` marker anywhere in the path.
 */
function detectFromWorktreePath(cwd: string): { projectSlug: string; taskShortId: string; realDev3Home: string } | null {
	// Strategy 1: HOME-based prefix match
	const prefix = `${WORKTREES_DIR}/`;
	const result = matchWorktreePrefix(cwd, prefix);
	if (result) return { ...result, realDev3Home: DEV3_HOME };

	// Strategy 2: find /.dev3.0/worktrees/ marker in cwd (sandbox fallback)
	const markerIdx = cwd.indexOf(WORKTREE_MARKER);
	if (markerIdx !== -1) {
		const fallbackPrefix = cwd.slice(0, markerIdx + WORKTREE_MARKER.length);
		const fallbackResult = matchWorktreePrefix(cwd, fallbackPrefix);
		if (fallbackResult) {
			const realDev3Home = cwd.slice(0, markerIdx) + "/.dev3.0";
			return { ...fallbackResult, realDev3Home };
		}
	}

	return null;
}

function matchWorktreePrefix(cwd: string, prefix: string): { projectSlug: string; taskShortId: string } | null {
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

	// Use real dev3 home (may differ from HOME-based DEV3_HOME in sandbox)
	const effectiveHome = pathInfo.realDev3Home;
	const projectsFile = `${effectiveHome}/projects.json`;
	const socketsDir = `${effectiveHome}/sockets`;

	// Find the project by slug match
	try {
		const projects = JSON.parse(readFileSync(projectsFile, "utf-8")) as Array<{ id: string; path: string }>;
		const project = projects.find((p) => {
			const slug = p.path.replace(/^\//, "").replaceAll("/", "-");
			return slug === pathInfo.projectSlug;
		});
		if (!project) return null;

		// Find the task by short ID prefix
		const taskDataDir = `${effectiveHome}/data/${pathInfo.projectSlug}`;
		const tasksFile = `${taskDataDir}/tasks.json`;
		if (!existsSync(tasksFile)) return null;

		const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
		const task = tasks.find((t) => t.id.startsWith(pathInfo.taskShortId));
		if (!task) return null;

		// Try to find a live socket (check real sockets dir first, then HOME-based)
		const socketPath = discoverSocketIn(socketsDir) || discoverSocket() || "";

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
 * Detect context from worktree path structure.
 */
export function detectContext(cwd: string = process.cwd()): CliContext | null {
	return resolveFromWorktreePath(cwd);
}

/**
 * Return diagnostic info when context detection fails.
 * Helps debug issues inside sandboxed environments (e.g. Codex seatbelt).
 */
export function detectContextDiagnostics(cwd: string = process.cwd()): string {
	const pathInfo = detectFromWorktreePath(cwd);
	const lines = [
		`  cwd: ${cwd}`,
		`  HOME: ${HOME}`,
		`  WORKTREES_DIR: ${WORKTREES_DIR}`,
		`  path parse: ${pathInfo ? `slug=${pathInfo.projectSlug} task=${pathInfo.taskShortId} realDev3Home=${pathInfo.realDev3Home}` : "null (path not matched)"}`,
	];
	if (pathInfo) {
		const projectsFile = `${pathInfo.realDev3Home}/projects.json`;
		const projectsExist = existsSync(projectsFile);
		lines.push(`  projects.json (${projectsFile}): ${projectsExist ? "exists" : "NOT FOUND"}`);
		if (projectsExist) {
			try {
				const projects = JSON.parse(readFileSync(projectsFile, "utf-8")) as Array<{ id: string; path: string }>;
				const slugMatch = projects.find((p) => {
					const slug = p.path.replace(/^\//, "").replaceAll("/", "-");
					return slug === pathInfo.projectSlug;
				});
				lines.push(`  project match: ${slugMatch ? `id=${slugMatch.id} path=${slugMatch.path}` : `none (looking for slug "${pathInfo.projectSlug}")`}`);
			} catch (e) {
				lines.push(`  projects.json read error: ${e}`);
			}
		}
		const taskDataDir = `${pathInfo.realDev3Home}/data/${pathInfo.projectSlug}`;
		const tasksFile = `${taskDataDir}/tasks.json`;
		lines.push(`  tasks.json (${tasksFile}): ${existsSync(tasksFile) ? "exists" : "NOT FOUND"}`);
	}
	return lines.join("\n");
}

/**
 * Find any live socket in a given sockets directory.
 */
function discoverSocketIn(socketsDir: string): string | null {
	if (!existsSync(socketsDir)) return null;

	const candidates: string[] = [];
	for (const file of readdirSync(socketsDir)) {
		if (!file.endsWith(".sock")) continue;
		const pid = parseInt(file.replace(".sock", ""), 10);
		if (isNaN(pid)) continue;

		const socketPath = `${socketsDir}/${file}`;
		try {
			process.kill(pid, 0); // Check if alive
			return socketPath;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "EPERM") {
				// Sandboxed environment (e.g. Codex seatbelt) blocks signals
				// to processes outside the sandbox. The app may still be alive —
				// keep as candidate and let the caller try to connect.
				candidates.push(socketPath);
			}
			// ESRCH = process doesn't exist — skip stale socket
		}
	}
	// Return first candidate from sandboxed fallback (if any).
	return candidates.length > 0 ? candidates[0] : null;
}

/**
 * Find any live socket in ~/.dev3.0/sockets/ (for commands without worktree context).
 */
export function discoverSocket(): string | null {
	return discoverSocketIn(SOCKETS_DIR);
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
 * Expand a short task ID (e.g. 8-char prefix from `tasks list`) to full UUID.
 * First checks the current context, then falls back to reading data files.
 */
export function expandShortId(id: string, context: CliContext | null): string {
	// Already a full UUID
	if (id.length >= 36) return id;
	// Check if context task matches the prefix
	if (context?.taskId?.startsWith(id)) return context.taskId;
	// Fall back to scanning data files across all projects
	try {
		const projects = JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")) as Array<{ id: string; path: string }>;
		for (const project of projects) {
			const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
			const tasksFile = `${DEV3_HOME}/data/${slug}/tasks.json`;
			if (!existsSync(tasksFile)) continue;
			const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
			const match = tasks.find((t) => t.id.startsWith(id));
			if (match) return match.id;
		}
	} catch {
		// Data files not available — return as-is
	}
	return id;
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
