import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

const HOME = process.env.HOME || "/tmp";
const DEV3_HOME = `${HOME}/.dev3.0`;
const SOCKETS_DIR = `${DEV3_HOME}/sockets`;
const WORKTREES_DIR = `${DEV3_HOME}/worktrees`;
const PROJECTS_FILE = `${DEV3_HOME}/projects.json`;
// Virtual ("Operations") projects live in a SEPARATE file so older app versions
// never see them. Offline ID resolution must read both or it goes blind to ops.
const VIRTUAL_PROJECTS_FILE = `${DEV3_HOME}/virtual-projects.json`;

/**
 * Read all projects (git + virtual) for offline ID resolution, without a socket.
 * Either file may be absent — an unreadable file contributes nothing rather than
 * throwing, so a missing virtual-projects.json simply yields the git projects.
 */
function readAllProjectsRaw(): Array<{ id: string; name?: string; path: string }> {
	const out: Array<{ id: string; name?: string; path: string }> = [];
	for (const file of [PROJECTS_FILE, VIRTUAL_PROJECTS_FILE]) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as Array<{ id: string; name?: string; path: string }>;
			if (Array.isArray(parsed)) out.push(...parsed);
		} catch {
			// File missing or unreadable — skip it.
		}
	}
	return out;
}

export interface CliContext {
	projectId: string;
	taskId: string;
	socketPath: string;
	/** Worktree root path (e.g. ~/.dev3.0/worktrees/slug/taskId/worktree) if detected from CWD. */
	worktreePath?: string;
}

/** Marker that appears in every dev3 worktree path. */
const WORKTREE_MARKER = "/.dev3.0/worktrees/";

/** Marker that appears in every virtual ("Operations") task working dir. */
const OPS_MARKER = "/.dev3.0/ops/";

/**
 * Parse worktree path to extract project slug and task short ID.
 * Path pattern: {any-home}/.dev3.0/worktrees/{projectSlug}/{taskShortId}/worktree
 *
 * First tries the HOME-based WORKTREES_DIR prefix. If that fails (e.g. Codex
 * sandbox rewrites HOME=/tmp while cwd still uses the real home), falls back
 * to searching for the `/.dev3.0/worktrees/` marker anywhere in the path.
 */
export function detectFromWorktreePath(cwd: string): { projectSlug: string; taskShortId: string; realDev3Home: string } | null {
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

		// Derive worktree root path from the parsed info
		const worktreeBase = `${effectiveHome}/worktrees/${pathInfo.projectSlug}/${pathInfo.taskShortId}/worktree`;

		return {
			projectId: project.id,
			taskId: task.id,
			socketPath,
			worktreePath: existsSync(worktreeBase) ? worktreeBase : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Parse a virtual ("Operations") task working dir to extract the readable slug
 * and task short ID. Path pattern:
 *   {any-home}/.dev3.0/ops/{readableSlug}/{taskShortId}/work[/...]
 * The readable slug is the basename of the virtual project's synthetic path —
 * NOT the munged projectSlug used for the data dir.
 */
function detectFromVirtualPath(cwd: string): { readableSlug: string; taskShortId: string; realDev3Home: string } | null {
	const markerIdx = cwd.indexOf(OPS_MARKER);
	if (markerIdx === -1) return null;
	const after = cwd.slice(markerIdx + OPS_MARKER.length);
	const parts = after.split("/");
	if (parts.length >= 3 && parts[2] === "work") {
		const realDev3Home = cwd.slice(0, markerIdx) + "/.dev3.0";
		return { readableSlug: parts[0], taskShortId: parts[1], realDev3Home };
	}
	return null;
}

/**
 * Resolve project and task IDs from a virtual task working dir. Reads
 * virtual-projects.json (NOT projects.json), matches the project by the
 * readable slug, then resolves tasks from the SAME data/<projectSlug(path)>
 * location used by git projects (the task data layer is not special-cased).
 */
function resolveFromVirtualPath(cwd: string): CliContext | null {
	const pathInfo = detectFromVirtualPath(cwd);
	if (!pathInfo) return null;

	const effectiveHome = pathInfo.realDev3Home;
	const virtualFile = `${effectiveHome}/virtual-projects.json`;
	const socketsDir = `${effectiveHome}/sockets`;

	try {
		const projects = JSON.parse(readFileSync(virtualFile, "utf-8")) as Array<{ id: string; path: string }>;
		const project = projects.find((p) => (p.path.split("/").pop() || "") === pathInfo.readableSlug);
		if (!project) return null;

		// Tasks live at data/<projectSlug(path)>/tasks.json — same formula as git.
		const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
		const tasksFile = `${effectiveHome}/data/${slug}/tasks.json`;
		if (!existsSync(tasksFile)) return null;

		const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
		const task = tasks.find((t) => t.id.startsWith(pathInfo.taskShortId));
		if (!task) return null;

		const socketPath = discoverSocketIn(socketsDir) || discoverSocket() || "";
		const workDir = `${effectiveHome}/ops/${pathInfo.readableSlug}/${pathInfo.taskShortId}/work`;

		return {
			projectId: project.id,
			taskId: task.id,
			socketPath,
			worktreePath: existsSync(workDir) ? workDir : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Detect context from worktree path structure (git) or virtual ops working dir.
 */
export function detectContext(cwd: string = process.cwd()): CliContext | null {
	return resolveFromWorktreePath(cwd) || resolveFromVirtualPath(cwd);
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

	const entries = readdirSync(socketsDir)
		.filter((file) => file.endsWith(".sock"))
		.map((file) => {
			const pid = parseInt(file.replace(".sock", ""), 10);
			if (isNaN(pid)) return null;
			const socketPath = `${socketsDir}/${file}`;
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(socketPath).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			return { pid, socketPath, mtimeMs };
		})
		.filter((entry): entry is { pid: number; socketPath: string; mtimeMs: number } => entry !== null)
		.sort((a, b) => {
			if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
			return b.pid - a.pid;
		});

	const candidates: string[] = [];
	for (const entry of entries) {
		const { pid, socketPath } = entry;
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
 * Like resolveSocketPath, but retries a few times with short backoff before
 * giving up. Discovery normally succeeds immediately (the app's socket file is
 * stable for its lifetime), but a tight race — the app momentarily recreating
 * its socket, or a filesystem hiccup right as a burst of CLI calls fires — can
 * make a single readdir/`kill(pid,0)` probe come up empty. Retrying turns that
 * transient miss into a successful resolve instead of a false "app not running"
 * (mirrors the connect-level retry in socket-client; see issue #714).
 */
export async function resolveSocketPathWithRetry(
	cwd?: string,
	opts: { attempts?: number; retryDelayMs?: number } = {},
): Promise<string | null> {
	const attempts = Math.max(1, opts.attempts ?? 4);
	for (let attempt = 0; attempt < attempts; attempt++) {
		const found = resolveSocketPath(cwd);
		if (found) return found;
		if (attempt === attempts - 1) break;
		await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? 75 * (attempt + 1)));
	}
	return null;
}

/**
 * Human-readable diagnostics for why socket resolution failed. Printed by the
 * CLI's "app not running" path when DEV3_DEBUG is set, so a future bug report
 * can distinguish a real-offline app from a wrong HOME / sandboxed-signal /
 * stale-socket situation instead of guessing. Never throws.
 */
export function socketDiagnostics(cwd: string = process.cwd()): string {
	const lines: string[] = [];
	lines.push(`  HOME: ${HOME}`);
	lines.push(`  cwd: ${cwd}`);
	lines.push(`  sockets dir: ${SOCKETS_DIR}`);

	if (!existsSync(SOCKETS_DIR)) {
		lines.push(`  sockets dir status: NOT FOUND (app never started, or HOME differs from the app's)`);
	} else {
		let files: string[] = [];
		try {
			files = readdirSync(SOCKETS_DIR).filter((f) => f.endsWith(".sock"));
		} catch (e) {
			lines.push(`  readdir error: ${e}`);
		}
		if (files.length === 0) {
			lines.push(`  sockets: none present`);
		}
		for (const f of files) {
			const pid = parseInt(f.replace(".sock", ""), 10);
			let state = "unknown";
			try {
				process.kill(pid, 0);
				state = "process alive";
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code;
				state = code === "EPERM" ? "EPERM (sandboxed — cannot probe, may be alive)" : "process dead (stale socket)";
			}
			lines.push(`  socket ${f}: pid=${isNaN(pid) ? "?" : pid} → ${state}`);
		}
	}

	const pathInfo = detectFromWorktreePath(cwd);
	lines.push(`  worktree context: ${pathInfo ? `slug=${pathInfo.projectSlug} task=${pathInfo.taskShortId}` : "not detected from cwd"}`);
	return lines.join("\n");
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
	// Fall back to scanning data files across all projects (git + virtual)
	try {
		for (const project of readAllProjectsRaw()) {
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
 * Expand a short project ID (e.g. 8-char prefix from `projects list`) to full UUID.
 * Mirrors expandShortId for tasks: the server matches projects by exact ID, so the
 * CLI must resolve short prefixes before sending them.
 */
export function expandShortProjectId(id: string, context: CliContext | null): string {
	// Already a full UUID
	if (id.length >= 36) return id;
	// Check if context project matches the prefix
	if (context?.projectId?.startsWith(id)) return context.projectId;
	// Fall back to scanning projects (git + virtual)
	try {
		const match = readAllProjectsRaw().find((p) => p.id.startsWith(id));
		if (match) return match.id;
	} catch {
		// Data files not available — return as-is
	}
	return id;
}

/**
 * Resolve the target project ID from a parsed --project flag (expanding short IDs)
 * or fall back to the worktree context. Returns undefined when neither is present.
 */
export function resolveProjectId(flagValue: string | undefined, context: CliContext | null): string | undefined {
	if (flagValue) return expandShortProjectId(flagValue, context);
	return context?.projectId;
}

/**
 * Read project info directly from data files (no socket needed).
 */
export function readProjectDirect(projectId: string): { id: string; name: string; path: string } | null {
	const match = readAllProjectsRaw().find((p) => p.id === projectId || p.id.startsWith(projectId));
	return match ? { id: match.id, name: match.name ?? "", path: match.path } : null;
}

/**
 * Read task info directly from data files (no socket needed).
 */
export function readTaskDirect(projectId: string, taskId: string): Record<string, unknown> | null {
	try {
		const project = readAllProjectsRaw().find((p) => p.id === projectId);
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
