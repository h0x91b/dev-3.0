import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ID_PREFIX_MIN_LENGTH } from "../shared/types";
import type { Project } from "../shared/types";
import { parseSocketMeta, parseTaskSocketOwner, socketMetaFileName, taskSocketOwnerPath } from "../shared/socket-meta";

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
 * Returns the full stored Project objects so callers can read column config
 * (customColumns, columnOrder, …) offline, not just id/name/path.
 */
function readAllProjectsRaw(): Project[] {
	const out: Project[] = [];
	for (const file of [PROJECTS_FILE, VIRTUAL_PROJECTS_FILE]) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as Project[];
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
		const socketPath = discoverSocketIn(socketsDir, undefined, task.id) || discoverSocket() || "";

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

		const socketPath = discoverSocketIn(socketsDir, undefined, task.id) || discoverSocket() || "";
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
 * Resolve context from the DEV3_TASK_ID env var that the app injects into every
 * task tmux pane (see buildAgentEnv / tmux-pty.ts). This is the fallback for
 * operations whose working dir is NOT under ~/.dev3.0/ops/<slug>/<task>/work:
 *  - a fixed-folder operation (user-picked opsWorkDir, e.g. ~/Downloads).
 * Path-based detection (worktree / managed-ops) can't see those, so without this
 * the agent status hooks (`dev3 task move … --if-status-not …`) silently no-op.
 * Scans all projects (git + virtual) for the task; the env var is the full UUID.
 */
function resolveFromEnv(): CliContext | null {
	const taskId = process.env.DEV3_TASK_ID;
	if (!taskId) return null;
	try {
		for (const project of readAllProjectsRaw()) {
			const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
			const tasksFile = `${DEV3_HOME}/data/${slug}/tasks.json`;
			if (!existsSync(tasksFile)) continue;
			const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
			if (tasks.some((t) => t.id === taskId)) {
				return {
					projectId: project.id,
					taskId,
					socketPath: discoverSocketIn(SOCKETS_DIR, undefined, taskId) || "",
				};
			}
		}
	} catch {
		// Data files unavailable — fall through to "no context".
	}
	return null;
}

/**
 * Detect context from worktree path structure (git), virtual ops working dir, or
 * the injected DEV3_TASK_ID env var (covers fixed-folder ops whose working dir
 * lives outside the ~/.dev3.0/ops/ tree). Path wins over env so
 * a user who `cd`s between worktrees in one pane resolves the dir they're in.
 */
export function detectContext(cwd: string = process.cwd()): CliContext | null {
	return resolveFromWorktreePath(cwd) || resolveFromVirtualPath(cwd) || resolveFromEnv();
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
 * True when the socket's meta sidecar marks a "guest" instance — a dev3 app
 * launched from inside a task context (`hostTaskId` set): the dev-channel build
 * a devScript boots inside the dev-server tmux session, or a headless
 * `dev3 remote` started from an agent pane. Guests share the data dir with the
 * primary app but must not win discovery: routing a stop/restart into a guest
 * hosted by the very dev session being stopped kills it mid-request (the
 * chronic "Empty response from server" / refused-socket failures, #910/#920).
 * No/corrupt sidecar (incl. sockets from older builds) means "primary".
 */
function readSocketMeta(socketsDir: string, pid: number) {
	try {
		const meta = parseSocketMeta(readFileSync(`${socketsDir}/${socketMetaFileName(pid)}`, "utf-8"));
		return meta?.pid === pid ? meta : null;
	} catch {
		return null;
	}
}

function readTaskSocketOwner(socketsDir: string, taskId: string) {
	const ownerPath = taskSocketOwnerPath(socketsDir, taskId);
	if (!ownerPath) return null;
	try {
		const owner = parseTaskSocketOwner(readFileSync(ownerPath, "utf-8"));
		return owner?.taskId === taskId ? owner : null;
	} catch {
		return null;
	}
}

/**
 * Find any live socket in a given sockets directory. Primary-instance sockets
 * are preferred over guest sockets; within each group the
 * newest mtime (then highest pid) wins. When `preferredTaskId` is provided, a
 * live instance that successfully created/restored that task's PTY wins first;
 * the newest task claim breaks ties across viewers and server restarts. A guest
 * hosted by the target task itself never gains this preference, preserving the
 * self-hosted stop/restart safety invariant from #910/#920. `exclude` skips
 * sockets that already failed this invocation (e.g. died mid-request) — vital
 * in sandboxed envs where liveness probes are EPERM-blocked and a dead socket
 * would otherwise be re-picked forever.
 */
function discoverSocketIn(
	socketsDir: string,
	exclude?: ReadonlySet<string>,
	preferredTaskId?: string,
): string | null {
	if (!existsSync(socketsDir)) return null;
	const taskOwner = preferredTaskId ? readTaskSocketOwner(socketsDir, preferredTaskId) : null;

	const entries = readdirSync(socketsDir)
		.filter((file) => file.endsWith(".sock"))
		.map((file) => {
			const pid = parseInt(file.replace(".sock", ""), 10);
			if (isNaN(pid)) return null;
			const socketPath = `${socketsDir}/${file}`;
			if (exclude?.has(socketPath)) return null;
			let mtimeMs = 0;
			try {
				mtimeMs = statSync(socketPath).mtimeMs;
			} catch {
				mtimeMs = 0;
			}
			const meta = readSocketMeta(socketsDir, pid);
			const guest = meta?.hostTaskId != null;
			const claimedAt = preferredTaskId && taskOwner && meta && meta.hostTaskId !== preferredTaskId && meta.ownerKey === taskOwner.ownerKey
				? taskOwner.claimedAt
				: undefined;
			return { pid, socketPath, mtimeMs, guest, claimedAt };
		})
		.filter((entry): entry is { pid: number; socketPath: string; mtimeMs: number; guest: boolean; claimedAt: number | undefined } => entry !== null)
		.sort((a, b) => {
			const aOwned = a.claimedAt !== undefined;
			const bOwned = b.claimedAt !== undefined;
			if (aOwned !== bOwned) return aOwned ? -1 : 1;
			if (aOwned && bOwned && b.claimedAt !== a.claimedAt) {
				return (b.claimedAt ?? 0) - (a.claimedAt ?? 0);
			}
			if (a.guest !== b.guest) return a.guest ? 1 : -1;
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
				// an explicitly ranked task owner must be tried before a lower-ranked
				// primary. Completion requests safely rediscover a different socket
				// if that connect reports APP_NOT_RUNNING.
				if (entry.claimedAt !== undefined) return socketPath;
				// Otherwise keep the historical confirmed-live primary preference.
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
 * Re-discovery for instance failover: find a live socket that is NOT one of the
 * given paths. Used by idempotent `devServer.*` commands when the instance
 * serving the request died mid-flight (its reply never arrived, or reconnects
 * are refused) — the replay must reach a DIFFERENT, surviving instance.
 */
export function discoverSocketExcluding(excludePaths: string[]): string | null {
	return discoverSocketIn(SOCKETS_DIR, new Set(excludePaths));
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

/** Resolve the renderer owner for an already-expanded task UUID. */
export function resolveSocketPathForTask(
	taskId: string,
	opts: { cwd?: string; excludePaths?: string[] } = {},
): string | null {
	const cwd = opts.cwd ?? process.cwd();
	const pathInfo = detectFromWorktreePath(cwd) ?? detectFromVirtualPath(cwd);
	const effectiveSocketsDir = pathInfo ? `${pathInfo.realDev3Home}/sockets` : SOCKETS_DIR;
	const exclude = new Set(opts.excludePaths ?? []);
	return discoverSocketIn(effectiveSocketsDir, exclude, taskId)
		|| (effectiveSocketsDir !== SOCKETS_DIR ? discoverSocketIn(SOCKETS_DIR, exclude, taskId) : null);
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
			const guestTag = !isNaN(pid) && readSocketMeta(SOCKETS_DIR, pid)?.hostTaskId != null
				? " [guest instance — deprioritized]"
				: "";
			lines.push(`  socket ${f}: pid=${isNaN(pid) ? "?" : pid} → ${state}${guestTag}`);
		}
	}

	const pathInfo = detectFromWorktreePath(cwd);
	lines.push(`  worktree context: ${pathInfo ? `slug=${pathInfo.projectSlug} task=${pathInfo.taskShortId}` : "not detected from cwd"}`);
	return lines.join("\n");
}

/**
 * Expand a short task ID (e.g. 8-char prefix from `tasks list`) to full UUID.
 * First checks the current context, then falls back to reading data files.
 *
 * The fallback scan mirrors the server's `findByIdPrefix` guard: a prefix shorter
 * than {@link ID_PREFIX_MIN_LENGTH} is NOT resolved (returned as-is so the server
 * rejects it), and a prefix that matches more than one task — across ALL projects,
 * which the server cannot see when no `--project` is passed — throws instead of
 * silently expanding to whichever task the project-iteration order hit first.
 * Without this, a typo'd `--task` prefix would be resolved to a full UUID and the
 * server's exact match would then mutate an arbitrary, wrong task. See decision 102.
 */
export function expandShortId(id: string, context: CliContext | null): string {
	// Already a full UUID
	if (id.length >= 36) return id;
	// Check if context task matches the prefix (context is authoritative — an
	// in-worktree short prefix legitimately means "this task", even below the min).
	if (context?.taskId?.startsWith(id)) return context.taskId;
	// Too short to safely disambiguate — leave as-is; the server will reject it.
	if (id.length < ID_PREFIX_MIN_LENGTH) return id;
	// Fall back to scanning data files across all projects (git + virtual).
	try {
		const matches: string[] = [];
		for (const project of readAllProjectsRaw()) {
			const slug = project.path.replace(/^\//, "").replaceAll("/", "-");
			const tasksFile = `${DEV3_HOME}/data/${slug}/tasks.json`;
			if (!existsSync(tasksFile)) continue;
			const tasks = JSON.parse(readFileSync(tasksFile, "utf-8")) as Array<{ id: string }>;
			for (const t of tasks) {
				if (t.id === id) return t.id; // exact match wins immediately
				if (t.id.startsWith(id)) matches.push(t.id);
			}
		}
		if (matches.length > 1) {
			const shown = matches.slice(0, 5).map((m) => m.slice(0, 12)).join(", ");
			throw new Error(
				`Ambiguous task prefix "${id}" matches ${matches.length} tasks (${shown}). Use a longer prefix or pass --project.`,
			);
		}
		if (matches.length === 1) return matches[0];
	} catch (err) {
		// Re-throw the ambiguity error; swallow only genuine read failures.
		if (err instanceof Error && err.message.startsWith("Ambiguous")) throw err;
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
	// Check if context project matches the prefix (context is authoritative).
	if (context?.projectId?.startsWith(id)) return context.projectId;
	// Too short to safely disambiguate — leave as-is; the server will reject it.
	if (id.length < ID_PREFIX_MIN_LENGTH) return id;
	// Fall back to scanning projects (git + virtual).
	try {
		const projects = readAllProjectsRaw();
		const exact = projects.find((p) => p.id === id);
		if (exact) return exact.id;
		const matches = projects.filter((p) => p.id.startsWith(id));
		if (matches.length > 1) {
			const shown = matches.slice(0, 5).map((m) => m.id.slice(0, 12)).join(", ");
			throw new Error(
				`Ambiguous project prefix "${id}" matches ${matches.length} projects (${shown}). Use a longer prefix.`,
			);
		}
		if (matches.length === 1) return matches[0].id;
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Ambiguous")) throw err;
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
 * A project as read directly from disk offline. `id`/`name`/`path` are always
 * present; every other Project field is best-effort (may be absent in older data
 * files), which is exactly the shape callers need to read column config offline.
 */
export type ProjectDirect = Pick<Project, "id" | "name" | "path"> & Partial<Project>;

/**
 * Read a project directly from data files (no socket needed). Returns the full
 * stored object (incl. customColumns/columnOrder/kind) so offline callers can
 * enumerate board columns; `name` is coalesced to "" if a legacy record lacks it.
 */
export function readProjectDirect(projectId: string): ProjectDirect | null {
	const match = readAllProjectsRaw().find((p) => p.id === projectId || p.id.startsWith(projectId));
	return match ? { ...match, name: match.name ?? "" } : null;
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
