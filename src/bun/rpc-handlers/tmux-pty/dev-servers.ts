import { realpathSync } from "node:fs";
import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { DevServerEntry, DevServerStatus, PortInfo, Project, Task } from "../../../shared/types";
import * as data from "../../data";
import * as git from "../../git";
import * as portPool from "../../port-pool";
import { buildProcessTree, clearDevServerSummaryForTask, clearPortDataForTask, collectDescendants, collectTaskPids, findPortHolders, getLsofOutput, getPortsForTask, getSessionPanePids, parseLsofOutput, scanTaskPorts, schedulePortScanSoon, waitForPortsFree } from "../../port-scanner";
import { classifyAgainstStartSnapshot, clearDevServerStart, clearDevServerStartsForTask, getDevServerStartSnapshot, mergePortInfos, recordDevServerStart } from "../../dev-server-ports";
import { DEFAULT_DEV_SERVER_NAME, devServerPortCount, devServerScriptBase, resolveDevServerRef, resolveDevServers, splitAssignedPorts, type DevServerResolution, type ResolvedDevServer } from "../../../shared/dev-servers";
import { clearDevServerArgs, clearDevServerEnv, readDevServerArgs, readDevServerEnv, saveDevServerArgs, saveDevServerEnv } from "../../dev-server-env-store";
import { sanitizeDevServerEnv } from "../../../shared/dev-server-env";
import { findWorktreeContainerPorts } from "../../container-ports";
import { getPidCwd, terminatePidsVerified } from "../../process-reaper";
import { getResourceUsage } from "../../resource-monitor";
import { tmux, DEFAULT_TMUX_SOCKET, TmuxError, isTmuxSpawnError, taskSessionName, devServerSessionName, isDevServerSessionOfTask, parseDev3SessionName, PANE_START_COMMAND_FORMAT, SESSION_OVERVIEW_FORMAT } from "../../tmux";
import { dev3TaskTempPath } from "../../temp-paths";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { nativeTaskPaneCommands } from "../../native-task-panes";
import { auxPaneAlive, auxPaneTitle, closeAuxPane, findAuxPane, nativeAuxPaneShellPid, openAuxPane } from "../../task-aux-panes";
import { buildTaskLifecycleEnv, shellQuote, generatedScriptLaunch, generatedScriptName, log, writeLaunchScript } from "../shared-pure";
import { assertPosixLaunchDialect } from "../../../shared/platform-launch";
import { buildDevServerScript, scriptArgsProblem } from "../../dev-server-script";
import { resetDevServerLog } from "../../dev-server-log";
import { devServerLogPath, DEV_SERVER_LOG_SINK_VERB } from "../../../shared/dev-server-log";
import { dev3CliExecutable } from "../../task-pane-runs";
import { resolveOperationalProjectConfig } from "../settings-config";

export const devViewerPaneIds = new Map<string, string>();

// True when THIS app process was launched from inside the given dev server's
// context. dev-3.0 dogfooding: the devScript (`bun run dev`) boots a dev3 app
// instance inside the task's dev tmux session, and that session's environment
// carries DEV3_TASK_ID and DEV3_DEV_SERVER (both set by runDevServer below).
// Tearing that session down reaps its full process tree — including this very
// process — so a stop/restart served by such a "self-hosted" instance must never
// run the teardown before the RPC reply is written, or the reply never arrives
// ("Empty response from server" / refused reconnects; issues #910/#920,
// decision `dev-server-self-hosted-instance-socket-refusal`).
//
// The server name is part of the identity: stopping the API server from an agent
// hosted by the FRONT END server is an ordinary stop, not a self-teardown.
function isSelfHostedByTask(taskId: string, serverName?: string): boolean {
	if (!process.env.DEV3_TASK_ID || process.env.DEV3_TASK_ID !== taskId) return false;
	if (!serverName) return true;
	return (process.env.DEV3_DEV_SERVER || DEFAULT_DEV_SERVER_NAME) === serverName;
}

// Delay before a self-hosted instance tears its own host session down: long
// enough for the already-returned RPC reply to flush to the CLI, short enough
// that the session is gone before anyone re-inspects it.
const SELF_HOSTED_STOP_ACK_MS = 500;

/** The whole dev-server picture of one task, read once per operation. */
interface DevServerContext {
	project: Project;
	task: Task;
	/** The project with its config cascade applied for this task's worktree. */
	resolved: Project;
	resolution: DevServerResolution;
	socket: string;
	native: boolean;
}

async function loadDevServerContext(projectId: string, taskId: string): Promise<DevServerContext> {
	const project = await data.getProject(projectId);
	const task = await data.getTask(project, taskId);
	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined, {
		foreignCode: task.foreignCode,
	});
	return {
		project,
		task,
		resolved,
		resolution: resolveDevServers(resolved),
		socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
		native: taskTerminalBackendIdentity(task) === "native",
	};
}

/** Which server one request means, as an Error the caller can throw. */
function pickServer(ctx: DevServerContext, name?: string): ResolvedDevServer {
	const picked = resolveDevServerRef(ctx.resolution, name);
	if ("server" in picked) return picked.server;
	throw new Error(picked.error);
}

/**
 * The same, for a STOP. Stopping is always legitimate, even for a task that
 * declares nothing today: its config may have changed while a server was up,
 * and refusing would strand that process with no way to reach it.
 */
function pickServerToStop(ctx: DevServerContext, name?: string): string {
	if (name) return name;
	return ctx.resolution.servers.length === 0
		? DEFAULT_DEV_SERVER_NAME
		: pickServer(ctx).name;
}

/** The generated wrapper script of one server — also its auxiliary-pane slot. */
function devServerScriptPath(taskId: string, serverName: string): string {
	return dev3TaskTempPath(taskId, generatedScriptName(devServerScriptBase(serverName)));
}

/**
 * Is this server up? A tmux task hosts it in its own nested session; a native
 * task runs it directly in an auxiliary pane, so the pane being alive IS the
 * server being alive.
 */
async function isDevServerRunning(task: Task, socket: string, serverName: string): Promise<boolean> {
	if (taskTerminalBackendIdentity(task) === "native") {
		return auxPaneAlive(task, "devServer", socket, devServerScriptBase(serverName));
	}
	// A launch-time tmux failure surfaces as a typed TmuxSpawnError (clear
	// FDA-pointing message) instead of a raw `posix_spawn ENOENT`. This is
	// the first — and gating — tmux call in the status path, so catching it in
	// buildDevServerStatus covers the whole read.
	return tmux.hasSession(devServerSessionName(task.id, serverName), { socket });
}

/**
 * The servers of this task that are actually up right now, by name — read from
 * the live sessions/panes rather than from the config, so a server whose
 * declaration was deleted while it ran is still torn down.
 */
async function liveDevServerNames(task: Task, socket: string): Promise<string[]> {
	// A native pane carries its script path in its launch command, which is the
	// only place its server name survives.
	if (taskTerminalBackendIdentity(task) === "native") return nativeDevServerPaneNames(task);
	try {
		const rows = await tmux.listSessions(SESSION_OVERVIEW_FORMAT, { socket });
		return rows
			.filter((row) => isDevServerSessionOfTask(row.name, task.id))
			.map((row) => parseDev3SessionName(row.name)?.serverName)
			.filter((name): name is string => !!name);
	} catch (err) {
		if (err instanceof TmuxError) return [];
		throw err;
	}
}

/** Native only: the server name behind every live dev-server pane of the task. */
async function nativeDevServerPaneNames(task: Task): Promise<string[]> {
	const prefix = dev3TaskTempPath(task.id, "dev");
	const names = new Set<string>();
	for (const pane of await nativeTaskPaneCommands(task.id)) {
		if (!pane.alive) continue;
		const joined = pane.command.join(" ");
		const at = joined.indexOf(prefix);
		if (at < 0) continue;
		// `…-dev.sh` is the default server, `…-dev-api.sh` is the one named `api`.
		const rest = joined.slice(at + prefix.length).split(/\s/)[0] ?? "";
		const base = rest.split(".")[0];
		names.add(base.startsWith("-") ? base.slice(1) : DEFAULT_DEV_SERVER_NAME);
	}
	return [...names];
}

/** Every server this task could be running: declared, plus anything still live. */
async function allDevServerNames(ctx: DevServerContext): Promise<string[]> {
	const names = new Set(ctx.resolution.servers.map((server) => server.name));
	for (const name of await liveDevServerNames(ctx.task, ctx.socket)) names.add(name);
	return [...names];
}

async function findDevServerViewerPaneId(
	taskId: string,
	taskSession: string,
	devSession: string,
	socket: string,
): Promise<string | null> {
	const cached = devViewerPaneIds.get(`${taskId}::${devSession}`);
	if (cached) {
		return cached;
	}

	try {
		const rows = await tmux.listPanes(PANE_START_COMMAND_FORMAT, { target: taskSession, socket });
		// The attach loop names the session, and `dev3-dev-<short>` is a prefix of
		// `dev3-dev-<short>-api` — so the match has to end at a word boundary or the
		// default server's viewer resolves to the API server's pane.
		return rows.find((row) => new RegExp(`${devSession}(?![\\w-])`).test(row.startCommand))?.paneId ?? null;
	} catch (err) {
		if (err instanceof TmuxError) return null;
		throw err;
	}
}

async function killDevServerViewerPane(taskId: string, taskSession: string, devSession: string, socket: string): Promise<void> {
	const viewerPaneId = await findDevServerViewerPaneId(taskId, taskSession, devSession, socket);
	if (!viewerPaneId) return;

	await tmux.killPane(viewerPaneId, { socket, bestEffort: true });
	devViewerPaneIds.delete(`${taskId}::${devSession}`);
	log.info("Killed dev server viewer pane", { taskId: taskId.slice(0, 8), viewerPaneId });
}

// tmux `kill-session` only delivers SIGHUP to each pane's *foreground* process
// (here: the `bash devScriptPath` wrapper). A dev server's real workload —
// vite/webpack/next, or electrobun plus the GUI `.app` bundle it launches —
// usually lives in deeper children that run in their own process group or get
// reparented to init when the wrapper dies, so they survive the teardown and
// keep holding ports (or windows) open. Snapshot the dev session's full
// descendant tree and reap it explicitly. See decision 092.
//
// Teardown is VERIFIED, not fire-and-forget: after SIGTERM we poll for actual
// process exit before escalating to SIGKILL, poll again, and finally wait for
// the task's pool ports to be released — so when stop/restart returns, the
// next start can really bind. See decision 099.
const DEV_SERVER_TERM_GRACE_MS = 1500;

const DEV_SERVER_KILL_WAIT_MS = 2000;

const DEV_SERVER_PORT_RELEASE_WAIT_MS = 3000;

// Docker's default stop grace is 10s before it SIGKILLs the container.
const CONTAINER_PORT_RELEASE_WAIT_MS = 15_000;

/**
 * The dev-server process tree of a NATIVE task: the pane's own shell plus every
 * descendant, from the same single `ps` snapshot the tmux walk uses (see the
 * note on collectDevServerTreePids for why `pgrep` is unusable here).
 */
async function collectNativeDevServerTreePids(task: Task, serverName: string): Promise<number[]> {
	const rootPid = await nativeAuxPaneShellPid(task, "devServer", devServerScriptBase(serverName));
	if (rootPid === null || rootPid <= 0) return [];
	const processTree = await buildProcessTree();
	return [rootPid, ...collectDescendants(rootPid, processTree)];
}

export async function collectDevServerTreePids(devSession: string, socket: string): Promise<number[]> {
	const panePids = await getSessionPanePids(socket, devSession);
	if (panePids.length === 0) return [];
	// Walk the descendant tree from a SINGLE `ps -eo pid,ppid` snapshot rather
	// than per-PID `pgrep -P`. When spawned from the packaged GUI `.app`,
	// `pgrep` returns nothing (its KERN_PROC_PPID sysctl is blocked under the
	// hardened runtime / sandbox), while `ps` is unaffected. With `pgrep`, the
	// reap captured ONLY the pane PID (which `tmux kill-session` already SIGHUPs)
	// and orphaned the entire dev-server tree — the Electrobun `.app` (and any
	// vite/webpack) kept running after Stop. A `ps`-based walk also crosses the
	// process-group boundary Electrobun creates for the launched app. See
	// decision 095.
	const processTree = await buildProcessTree();
	const tree = new Set<number>();
	for (const pid of panePids) {
		tree.add(pid);
		for (const child of collectDescendants(pid, processTree)) tree.add(child);
	}
	return [...tree];
}

/** Every pid belonging to one server, on whichever backend hosts it. */
async function collectOneDevServerPids(task: Task, socket: string, serverName: string): Promise<number[]> {
	return taskTerminalBackendIdentity(task) === "native"
		? collectNativeDevServerTreePids(task, serverName)
		: collectDevServerTreePids(devServerSessionName(task.id, serverName), socket);
}

// Reap a previously-captured PID set with verification: SIGTERM for a graceful
// shutdown (lets dev servers release ports / flush state), poll for actual
// exit, SIGKILL the survivors, poll again. Pass the PIDs captured *before* the
// tmux session was torn down — they stay valid after the wrapper dies
// (children just reparent to init). Returns PIDs still alive at the end.
export async function reapDevServerTree(pids: number[], devSession: string): Promise<number[]> {
	if (pids.length === 0) return [];
	const leftovers = await terminatePidsVerified(pids, {
		termGraceMs: DEV_SERVER_TERM_GRACE_MS,
		killWaitMs: DEV_SERVER_KILL_WAIT_MS,
	});
	if (leftovers.length > 0) {
		log.error("Dev server processes survived SIGKILL", { devSession, leftovers });
	} else {
		log.info("Reaped dev server process tree (verified dead)", { devSession, count: pids.length });
	}
	return leftovers;
}

// A devScript child that daemonizes (double-fork → reparented to init BEFORE
// our snapshot) is invisible to the ppid tree walk, yet keeps holding the
// task's pool ports after Stop. Find such orphans by port ownership: whoever
// LISTENs on an assigned port, is not in any of our live session trees, and
// has its cwd inside the task worktree is ours to reap. Anything else holding
// the port is a foreign process — reported, never killed. Ownership is checked
// via `lsof -d cwd` because env/args inspection (`ps -E`) is blocked for other
// PIDs under the packaged `.app` hardened runtime (see decisions 095/099).
async function findOrphanedPortHolders(
	taskId: string,
	worktreePath: string | undefined,
	knownPids: Set<number>,
	ports?: number[],
): Promise<{ orphanPids: number[]; foreignHolders: PortInfo[] }> {
	const assignedPorts = ports ?? portPool.getPortAssignments(taskId);
	if (assignedPorts.length === 0 || !worktreePath) return { orphanPids: [], foreignHolders: [] };

	const holders = await findPortHolders(assignedPorts);
	if (holders.length === 0) return { orphanPids: [], foreignHolders: [] };

	// lsof resolves symlinks in cwd paths (e.g. /tmp → /private/tmp).
	let resolvedWorktree = worktreePath;
	try {
		resolvedWorktree = realpathSync(worktreePath);
	} catch {
		// Worktree already removed — fall back to the raw path.
	}

	const orphanPids = new Set<number>();
	const foreignHolders: PortInfo[] = [];
	let processTree: Map<number, number[]> | null = null;
	for (const holder of holders) {
		if (knownPids.has(holder.pid) || orphanPids.has(holder.pid)) continue;
		const cwd = await getPidCwd(holder.pid);
		const isOurs = cwd !== null && [worktreePath, resolvedWorktree].some(
			(root) => cwd === root || cwd.startsWith(root + "/"),
		);
		if (isOurs) {
			processTree ??= await buildProcessTree();
			orphanPids.add(holder.pid);
			for (const child of collectDescendants(holder.pid, processTree)) orphanPids.add(child);
		} else {
			foreignHolders.push(holder);
		}
	}
	return { orphanPids: [...orphanPids], foreignHolders };
}

/**
 * Tear down dev servers of a task and PROVE they are gone.
 *
 * `servers` names which ones; omitting it means every server the task is
 * running, which is what task teardown and hibernation want. Stopping one
 * server never touches another's processes or ports: the siblings' pids are
 * collected first and excluded from the orphan sweep, and only the stopped
 * server's own ports are waited on.
 */
export async function killDevServerSession(
	task: Task,
	socket: string,
	worktreePath?: string | null,
	opId?: string,
	servers?: string[],
): Promise<void> {
	const taskId = task.id;
	const native = taskTerminalBackendIdentity(task) === "native";
	const taskSession = taskSessionName(taskId);
	const live = await liveDevServerNames(task, socket);
	// A teardown names no server, so it takes whatever is live — plus the default
	// one unconditionally. Discovery can come back empty when the listing itself
	// failed, and a task must never be torn down leaving its dev server running;
	// killing a session that is already gone is a no-op.
	const targets = servers ?? [...new Set([DEFAULT_DEV_SERVER_NAME, ...live])];
	// A teardown of the whole task must leave nothing behind, including the
	// snapshot of a server that had already exited on its own.
	if (!servers) clearDevServerStartsForTask(taskId);
	if (targets.length === 0) {
		log.info("Killed dev server session: nothing was running", { taskId: taskId.slice(0, 8), ...(opId ? { opId } : {}) });
		// Still clear the per-task caches: a stop must leave no stale snapshot.
		for (const name of servers ?? []) clearDevServerStart(taskId, name);
		refreshBoardDevServer(taskId);
		return;
	}
	const survivors = live.filter((name) => !targets.includes(name));

	// Snapshot the process trees while the servers are still up — afterwards their
	// root pids are unreachable (tmux forgets the session; the native pane is gone).
	const treePids: number[] = [];
	for (const name of targets) treePids.push(...(await collectOneDevServerPids(task, socket, name)));
	// A sibling server that keeps running owns its own listeners: they must never
	// look like orphans of the server being stopped.
	const protectedPids = native ? new Set<number>() : await collectTaskPids(socket, taskSession);
	for (const name of survivors) {
		for (const pid of await collectOneDevServerPids(task, socket, name)) protectedPids.add(pid);
	}
	for (const pid of treePids) protectedPids.add(pid);

	// Detached/daemonized devScript children are missed by the tree walk — find
	// them by pool-port ownership. Processes in the TASK session tree (agent
	// panes) are excluded: an agent-launched server on a pool port is not the
	// dev server's to kill.
	const ownedPorts = devServerOwnedPorts(taskId, targets, survivors.length === 0);
	const { orphanPids, foreignHolders } = await findOrphanedPortHolders(taskId, worktreePath ?? undefined, protectedPids, ownedPorts);
	if (orphanPids.length > 0) {
		log.warn("Reaping detached dev-server processes found via port ownership", { taskId: taskId.slice(0, 8), orphanPids });
	}
	if (foreignHolders.length > 0) {
		log.warn("Assigned ports held by foreign processes — not killing", { taskId: taskId.slice(0, 8), foreignHolders });
		// Classify while the snapshot is still here: a holder published for THIS
		// dev server (a container runtime daemon) usually survives the stop, and
		// the next start must not read it back as a squatter.
		for (const name of targets) classifyAgainstStartSnapshot(taskId, name, foreignHolders, true);
	}

	for (const name of targets) {
		const devSession = devServerSessionName(taskId, name);
		if (native) {
			// The pane IS the dev server: closing it kills the script, and the reap
			// below finishes off anything it left behind. No tmux is touched.
			await closeAuxPane(task, "devServer", socket, opId, devServerScriptBase(name));
		} else {
			await killDevServerViewerPane(taskId, taskSession, devSession, socket);
			await tmux.killSession(devSession, { socket, bestEffort: true });
		}
		clearDevServerStart(taskId, name);
	}
	const leftovers = await reapDevServerTree([...treePids, ...orphanPids], targets.join(","));

	// "Stop returned" must mean "the next start can bind": wait for the stopped
	// servers' ports to actually be released. Ports squatted by foreign processes
	// are excluded — they will never free and are already reported above. This
	// worktree's own container is not foreign: its stop outlives the HUP, and a
	// restart that skips the wait reads the old container as the new one ready.
	const containerPorts = foreignHolders.length > 0 && worktreePath
		? await findWorktreeContainerPorts(worktreePath)
		: new Set<number>();
	const foreignPorts = new Set(foreignHolders.filter((h) => !containerPorts.has(h.port)).map((h) => h.port));
	const waitPorts = ownedPorts.filter((port) => !foreignPorts.has(port));
	const releaseWaitMs = waitPorts.some((port) => containerPorts.has(port))
		? CONTAINER_PORT_RELEASE_WAIT_MS
		: DEV_SERVER_PORT_RELEASE_WAIT_MS;
	const stuckHolders = await waitForPortsFree(waitPorts, releaseWaitMs);
	if (stuckHolders.length > 0) {
		log.warn("Assigned ports still held after teardown", { taskId: taskId.slice(0, 8), stuckHolders });
	}
	clearPortDataForTask(taskId);
	refreshBoardDevServer(taskId);
	log.info("Killed dev server sessions", {
		taskId: taskId.slice(0, 8),
		...(opId ? { opId } : {}),
		servers: targets,
		reaped: treePids.length + orphanPids.length,
		leftovers: leftovers.length,
		stuckPorts: stuckHolders.map((h) => h.port),
	});
}

/**
 * The pool ports a stop has to see released: the named ports of the servers
 * going down, plus the positional block when nothing else is left running (a
 * positional port belongs to the task, so only an empty task frees it).
 */
function devServerOwnedPorts(taskId: string, targets: string[], lastOnes: boolean): number[] {
	const assigned = portPool.getPortAssignments(taskId);
	if (lastOnes) return assigned;
	const snapshots = targets
		.map((name) => getDevServerStartSnapshot(taskId, name))
		.filter((snapshot): snapshot is NonNullable<typeof snapshot> => !!snapshot);
	if (snapshots.length === 0) return assigned;
	return [...new Set(snapshots.flatMap((snapshot) => snapshot.assignedPorts))];
}

/**
 * Re-read this task's dev server for the Kanban board on the next tick. The
 * board is fed by the 10-second port poller, which is far too slow to answer a
 * click the user just made.
 */
function refreshBoardDevServer(taskId: string): void {
	clearDevServerSummaryForTask(taskId);
	schedulePortScanSoon();
}

/**
 * The shell command `pipe-pane` feeds the dev pane's bytes to: dev3's own CLI,
 * not `cat >> file`. That is what strips the escapes, collapses the progress
 * bars and caps the size — and it is one program on every platform, unlike a
 * shell pipeline (same reasoning as the pane runs, see `pane-exec.ts`).
 */
function devServerLogSinkCommand(logPath: string): string {
	return `${shellQuote(dev3CliExecutable())} ${DEV_SERVER_LOG_SINK_VERB} ${shellQuote(logPath)}`;
}

/**
 * Where ONE server's output is mirrored as plain text. Beside the worktree,
 * never inside it — a log under `<worktree>/` would show up untracked in `git
 * status`. Null for a task that has no worktree to hang it off.
 */
function devServerLogFileFor(ctx: DevServerContext, serverName: string): string | null {
	if (!ctx.task.worktreePath) return null;
	return devServerLogPath(git.taskDir(ctx.project, ctx.task), serverName);
}

/** The task's assigned ports, split into the positional block and the named ones. */
function taskPortLayout(ctx: DevServerContext): { assigned: number[]; positional: number[]; named: Record<string, number> } {
	const assigned = portPool.getPortAssignments(ctx.task.id);
	const { positional, named } = splitAssignedPorts(assigned, ctx.resolved.portCount ?? 0, ctx.resolution.namedPorts);
	return { assigned, positional, named };
}

/**
 * The whole dev-server state of a task: one entry per declared server, plus the
 * facts that belong to the task itself.
 */
async function buildDevServerStatus(ctx: DevServerContext): Promise<DevServerStatus> {
	const { task, resolution, socket, native } = ctx;
	const taskSession = taskSessionName(task.id);
	// `assignedPorts` comes from the in-memory port pool — no tmux — so it stays
	// available as "last-known state" even when tmux can't be reached.
	const { assigned, named } = taskPortLayout(ctx);
	const envelope = {
		projectId: ctx.project.id,
		taskId: task.id,
		hasDevScript: resolution.servers.length > 0,
		worktreePath: task.worktreePath ?? null,
		tmuxSocket: socket,
		taskSessionName: native ? "" : taskSession,
		backend: (native ? "native" : "tmux") as DevServerStatus["backend"],
		assignedPorts: assigned,
		namedPorts: named,
		configErrors: resolution.errors,
	};

	// A launch-time tmux failure (e.g. macOS Full Disk Access lost) used to crash
	// the read-only status with a raw `posix_spawn ENOENT`. Degrade instead: keep
	// the tmux-free facts, mark the live state unknown, and carry the diagnostic
	// in `tmuxError` for the caller to surface. Non-tmux errors still propagate.
	let runningNames: string[];
	try {
		runningNames = [];
		for (const server of resolution.servers) {
			if (await isDevServerRunning(task, socket, server.name)) runningNames.push(server.name);
		}
	} catch (err) {
		if (!isTmuxSpawnError(err)) throw err;
		log.error("dev-server status degraded — tmux unreachable", {
			taskId: task.id.slice(0, 8),
			error: err.message,
		});
		return {
			...envelope,
			running: false,
			ports: [],
			servers: resolution.servers.map((server) => emptyEntry(ctx, server)),
			tmuxError: err.message,
		};
	}

	const anyRunning = runningNames.length > 0;
	// One live lsof snapshot shared by every server's dev-port scan, the conflict
	// checks, and the whole-task-session fallback below. Skipped entirely when
	// there is nothing to look at (stopped + no assigned ports).
	const lsofOutput = anyRunning || assigned.length > 0 ? await getLsofOutput() : "";

	const servers: DevServerEntry[] = [];
	for (const server of resolution.servers) {
		servers.push(await buildDevServerEntry(ctx, server, runningNames.includes(server.name), lsofOutput));
	}

	const ports = anyRunning
		? await (async () => {
			const published = servers.flatMap((entry) => entry.publishedPorts);
			const cached = getPortsForTask(task.id);
			if (cached.length > 0) return mergePortInfos(cached, published);
			// The fallback scan walks a tmux session; a native task has none, so the
			// per-server dev-port scans above are already the whole answer.
			const scanned = native
				? servers.flatMap((entry) => entry.devPorts)
				: await scanTaskPorts(socket, taskSession, lsofOutput);
			return mergePortInfos(scanned, published);
		})()
		: [];

	return { ...envelope, running: anyRunning, ports, servers };
}

/** A declared server with nothing read about it — the degraded-tmux answer. */
function emptyEntry(ctx: DevServerContext, server: ResolvedDevServer): DevServerEntry {
	const { named } = taskPortLayout(ctx);
	return {
		name: server.name,
		title: server.title,
		isDefault: server.isDefault,
		running: false,
		devSessionName: ctx.native ? "" : devServerSessionName(ctx.task.id, server.name),
		viewerPaneId: null,
		panePids: [],
		namedPorts: Object.fromEntries(server.ports.filter((port) => named[port] !== undefined).map((port) => [port, named[port]])),
		logPath: devServerLogFileFor(ctx, server.name),
		devPorts: [],
		publishedPorts: [],
		portConflicts: [],
		extraEnvKeys: Object.keys(readDevServerEnv(ctx.task.id, server.name)).sort(),
		scriptArgs: readDevServerArgs(ctx.task.id, server.name),
	};
}

async function buildDevServerEntry(
	ctx: DevServerContext,
	server: ResolvedDevServer,
	running: boolean,
	lsofOutput: string,
): Promise<DevServerEntry> {
	const { task, socket, native } = ctx;
	const taskSession = taskSessionName(task.id);
	const devSession = devServerSessionName(task.id, server.name);
	const slot = devServerScriptBase(server.name);
	const base = emptyEntry(ctx, server);
	if (!running) {
		// An assigned port already taken while the server is down is the bind
		// crash-loop waiting to happen, so it is still classified here.
		const holders = lsofOutput ? await findPortHolders(assignedPortsOf(ctx, server), lsofOutput) : [];
		return { ...base, portConflicts: classifyAgainstStartSnapshot(task.id, server.name, holders, false).conflicts };
	}

	const viewerPaneId = native
		? (await findAuxPane(task, "devServer", socket, slot))?.paneId ?? null
		: await findDevServerViewerPaneId(task.id, taskSession, devSession, socket);
	const nativeRootPid = native ? await nativeAuxPaneShellPid(task, "devServer", slot) : null;
	const panePids = native
		? (nativeRootPid ? [nativeRootPid] : [])
		: await getSessionPanePids(socket, devSession);
	const devTreePids = native
		? new Set(await collectNativeDevServerTreePids(task, server.name))
		: await collectTaskPids(socket, devSession);
	const devPorts = lsofOutput ? parseLsofOutput(lsofOutput, devTreePids) : [];
	// An assigned pool port bound by a PID outside the dev-server tree is either
	// the dev server's port published on its behalf (a container runtime daemon
	// owns every published port — it is never a descendant of the pane) or a
	// foreign squatter that will make the devScript crash-loop on bind. The
	// pre-start snapshot tells them apart.
	const foreignHolders = lsofOutput
		? (await findPortHolders(assignedPortsOf(ctx, server), lsofOutput)).filter((holder) => !devTreePids.has(holder.pid))
		: [];
	const { published, conflicts } = classifyAgainstStartSnapshot(task.id, server.name, foreignHolders, true);

	return {
		...base,
		running: true,
		viewerPaneId,
		panePids,
		devPorts,
		publishedPorts: published,
		portConflicts: conflicts,
		resourceUsage: getResourceUsage(task.id),
	};
}

/**
 * The pool ports one server is judged against: its own named ports, or — for a
 * server that declares none — the task's positional block, which is what such a
 * server binds through `$DEV3_PORT0`.
 */
function assignedPortsOf(ctx: DevServerContext, server: ResolvedDevServer): number[] {
	const { positional, named } = taskPortLayout(ctx);
	const own = server.ports.map((port) => named[port]).filter((port): port is number => port !== undefined);
	return own.length > 0 ? own : positional;
}

export async function setTmuxSessionPortEnv(taskId: string, socket: string): Promise<void> {
	const ports = portPool.getPortAssignments(taskId);
	if (ports.length === 0) return;

	const tmuxSession = taskSessionName(taskId);
	const envVars = portPool.buildPortEnv(ports);

	for (const [key, value] of Object.entries(envVars)) {
		await tmux.setEnvironment(tmuxSession, key, value, { socket, bestEffort: true });
	}

	log.info("Port env vars set on tmux session", { taskId: taskId.slice(0, 8), vars: Object.keys(envVars) });
}

/**
 * Make sure the task holds every pool port its dev servers need: the positional
 * block `portCount` asks for, plus one per named port. Allocation EXTENDS an
 * existing assignment, so adding a server never moves a port a running server
 * is already bound to.
 *
 * Idempotent, so it also back-fills tasks whose worktree was created before Port
 * Allocation (portCount) was configured — otherwise the dev app's remote web
 * server (DEV3_REMOTE_PORT=${DEV3_PORT0:-0}) could never bind a deterministic
 * port on such a task without recreating the worktree. See decision 093.
 */
async function ensureDevServerPorts(ctx: DevServerContext): Promise<void> {
	const needed = devServerPortCount(ctx.resolved.portCount ?? 0, ctx.resolution.namedPorts);
	if (needed === 0) return;
	if (portPool.getPortAssignments(ctx.task.id).length === needed) return;
	try {
		const ports = await portPool.allocatePorts(ctx.task.id, needed);
		log.info("Dev-server allocated pool ports", { taskId: ctx.task.id.slice(0, 8), ports });
	} catch (err) {
		log.error("Dev-server port allocation failed (non-fatal)", {
			taskId: ctx.task.id.slice(0, 8), needed, error: String(err),
		});
	}
}

/**
 * Where a running server's viewer pane goes. The first one splits the task
 * window in half; every later one splits the right-hand column, so the agent
 * keeps the left half however many servers are up.
 */
async function devServerViewerTarget(ctx: DevServerContext, exclude: string): Promise<{ tmuxTarget?: string; nativeAnchor?: string }> {
	for (const name of await liveDevServerNames(ctx.task, ctx.socket)) {
		if (name === exclude) continue;
		if (ctx.native) {
			const pane = await findAuxPane(ctx.task, "devServer", ctx.socket, devServerScriptBase(name));
			if (pane) return { nativeAnchor: pane.paneId };
			continue;
		}
		const paneId = await findDevServerViewerPaneId(
			ctx.task.id,
			taskSessionName(ctx.task.id),
			devServerSessionName(ctx.task.id, name),
			ctx.socket,
		);
		if (paneId) return { tmuxTarget: paneId };
	}
	return {};
}

/**
 * `args` come from the CLI, the renderer or any socket client, so the shape is
 * checked here. A NUL cannot live in a process argument. One argument list
 * cannot mean the same thing to several servers, hence no `all`.
 */
function assertScriptArgs(args: unknown, all: boolean | undefined): asserts args is string[] | undefined {
	if (args === undefined) return;
	if (!Array.isArray(args) || args.some((item) => typeof item !== "string" || item.includes("\0"))) {
		throw new Error("Script arguments must be a list of strings without NUL characters");
	}
	if (all) throw new Error("Script arguments go to one dev server — name it instead of using all");
}

/**
 * `env` is the caller's own extra environment (`dev3 dev-server start --env
 * KEY=VALUE`). Absent means "no extra env for this run" and CLEARS whatever the
 * previous run stored — a start defines its configuration whole. Only
 * `restartDevServer` carries the previous set forward.
 *
 * `server` names ONE declared server; `all` starts every one of them. Neither
 * means the default server, exactly as before.
 */
export async function runDevServer(params: { taskId: string; projectId: string; opId?: string; env?: Record<string, string>; args?: string[]; server?: string; all?: boolean }): Promise<DevServerStatus> {
	// Echo the renderer's correlation id so a click that never reached a handler is
	// distinguishable from one that did (seq 1407).
	// Values redacted: an extra env pair can carry a secret and this log is a file.
	// Args are logged as a count, like env as keys: either can carry a secret.
	log.info("→ runDevServer", { ...params, env: params.env ? Object.keys(params.env).sort() : undefined, args: params.args?.length });
	try {
		assertScriptArgs(params.args, params.all);
		const ctx = await loadDevServerContext(params.projectId, params.taskId);
		if (ctx.resolution.servers.length === 0) throw new Error("No dev script configured");
		if (!ctx.task.worktreePath) throw new Error("Task has no worktree");
		if (ctx.resolution.errors.length > 0) throw new Error(ctx.resolution.errors.join("; "));

		const targets = params.all ? ctx.resolution.servers : [pickServer(ctx, params.server)];
		await ensureDevServerPorts(ctx);
		for (const server of targets) {
			await startOneDevServer(ctx, server, params.env, params.args, params.opId);
		}
		refreshBoardDevServer(params.taskId);
		return buildDevServerStatus(ctx);
	} catch (err) {
		log.error("runDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

async function startOneDevServer(
	ctx: DevServerContext,
	server: ResolvedDevServer,
	env: Record<string, string> | undefined,
	args: string[] | undefined,
	opId?: string,
): Promise<void> {
	const { task, project, native, socket } = ctx;
	const worktreePath = assertTaskWorkspacePresent(project, task.worktreePath, task);
	// Never trust the caller: `devServer.start` is reachable from the CLI, the
	// renderer, and any other socket client, and only the CLI validates.
	const callerEnv = sanitizeDevServerEnv(env);
	const scriptArgs = args ?? [];
	const argsProblem = scriptArgs.length > 0 ? scriptArgsProblem(server.script) : null;
	if (argsProblem) throw new Error(argsProblem);
	saveDevServerEnv(task.id, server.name, callerEnv);
	saveDevServerArgs(task.id, server.name, scriptArgs);

	const devSession = devServerSessionName(task.id, server.name);
	const devScriptPath = devServerScriptPath(task.id, server.name);

	if (await isDevServerRunning(task, socket, server.name)) {
		if (isSelfHostedByTask(task.id, server.name)) {
			throw new Error(
				"The running dev server hosts the dev3 app instance serving this request "
				+ "(dev-3.0 running inside dev-3.0) — killing it would drop this reply. "
				+ "Route the command through the primary app instance, or run "
				+ "\"dev3 dev-server stop\" first and then \"dev3 dev-server start\".",
			);
		}
		await killDevServerSession(task, socket, worktreePath, opId, [server.name]);
	}

	const { positional, named } = taskPortLayout(ctx);
	const ownPorts = assignedPortsOf(ctx, server);
	// Surface "port already in use" at start time instead of leaving the
	// devScript to crash-loop on bind with only a downstream 502 as evidence.
	// The start still proceeds (the script may not use the squatted port) —
	// the conflict is logged here and returned in the status' portConflicts.
	const preStartHolders = await findPortHolders(ownPorts);
	// This worktree's own container, still up from the previous run, is not a
	// squatter: its runtime daemon keeps the same PID across the recreate.
	const ownContainerPorts = preStartHolders.length > 0 ? await findWorktreeContainerPorts(worktreePath) : new Set<number>();
	const preStartConflicts = preStartHolders.filter((holder) => !ownContainerPorts.has(holder.port));
	// The snapshot is what later lets status tell "published for this dev
	// server by a container runtime" from "squatted by something else".
	recordDevServerStart(task.id, server.name, ownPorts, preStartConflicts);
	if (preStartConflicts.length > 0) {
		log.warn("Assigned ports already in use before dev-server start", {
			taskId: task.id.slice(0, 8),
			server: server.name,
			conflicts: preStartConflicts,
		});
	}

	// Detaching the outer viewer pane before this pane closes lets the inner tmux
	// redraw without a watching client — it prevents escape-sequence corruption in
	// the outer tmux. A native pane has no nesting and no tmux binary to call, so
	// the line is tmux-only. Use the app-resolved binary: a PATH tmux of a
	// different version cannot talk to this server ("server exited unexpectedly").
	const tmuxDetachCommand = native ? null : `"${tmux.binaryPath()}" detach-client 2>/dev/null || true`;
	// One run's log is that run's output: an appended-to file would show a
	// previous crash as if it had just happened. Cleared before anything can
	// capture, so the file the status reports is never a stale one.
	const logPath = devServerLogFileFor(ctx, server.name);
	if (logPath) resetDevServerLog(logPath);
	const wrappedScript = buildDevServerScript({
		devScript: server.script,
		scriptArgs,
		envGroups: [
			ctx.resolved.env ?? {},
			// This server's own env sits above the project's and below the caller's:
			// a project-wide variable is the default, a per-server one is the
			// server's own setting, and `--env` is what this one run was asked for.
			server.env,
			// The caller's own env, so it can override a project `env` entry it
			// disagrees with — and no more than that. It sits BEFORE the groups
			// below deliberately: neither the task's identity nor its assigned ports
			// may be moved from outside, or `--wait` polls a port the server was
			// told not to bind.
			callerEnv,
			// Same workspace env the setup/cleanup hooks get, so a devScript can
			// reference root-resolved hooks ("$DEV3_PROJECT_PATH/...") too.
			buildTaskLifecycleEnv(project, task, worktreePath),
			positional.length > 0 ? portPool.buildPortEnv(positional) : {},
			// EVERY server gets EVERY named port of the task: that is what lets the
			// back office call the API without anyone wiring ports by hand.
			portPool.buildNamedPortEnv(named),
			{ DEV3_DEV_SERVER: server.name },
		],
		tmuxDetachCommand,
	});
	await writeLaunchScript(devScriptPath, wrappedScript);

	const cwd = server.cwd ? `${worktreePath}/${server.cwd}` : worktreePath;
	const paneEnv = { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: worktreePath, DEV3_DEV_SERVER: server.name };
	const anchor = await devServerViewerTarget(ctx, server.name);

	// A native task has no tmux anything. The dev script runs directly in a
	// real auxiliary pane of the task's own terminal: that pane IS the dev
	// server, so its output is live, closing it stops the server, and a second
	// viewer of the same task sees the same pane. The seam replaces any pane
	// this server already owns, so repeated starts never stack two.
	if (native) {
		const handle = await openAuxPane({
			task,
			purpose: "devServer",
			slot: devServerScriptBase(server.name),
			// The first server splits the agent's pane to the right; the next ones
			// split the server column that is already there, so the agent keeps half
			// the terminal however many servers run.
			placement: anchor.nativeAnchor ? "below" : "right",
			nativeAnchor: anchor.nativeAnchor,
			size: "50%",
			cwd,
			env: paneEnv,
			socket,
			title: devServerPaneTitle(server),
			tmuxCommand: `bash "${devScriptPath}"`,
			nativeLaunch: generatedScriptLaunch(devScriptPath),
			// The native session host mirrors this pane into the task log itself —
			// there is no tmux here to pipe from, and the pane keeps its own tty.
			...(logPath ? { outputLogPath: logPath } : {}),
		});
		log.info("← startOneDevServer done (native pane)", {
			taskId: task.id.slice(0, 8),
			server: server.name,
			...(opId ? { opId } : {}),
			paneId: handle.paneId,
		});
		return;
	}

	// Everything below hosts the dev server in a NESTED tmux session and views it
	// through a second tmux pane. That is the tmux backend's shape, not a
	// platform-neutral one, so it refuses here rather than half-running. A
	// Windows task is always native (see `newTaskTerminalBackend`), so this is
	// unreachable there — reaching it would be a wiring bug.
	assertPosixLaunchDialect("the nested dev-server tmux session");
	try {
		// Client cwd is pinned inside newSessionDetached — never a mortal
		// worktree, or a tmux server started by this client keeps it forever.
		const { stderr } = await tmux.newSessionDetached({
			sessionName: devSession,
			cwd,
			env: paneEnv,
			command: `bash "${devScriptPath}"`,
			// Mirror the pane into this server's log file, chained onto this very
			// invocation so the capture is on before the pane's first byte. The pane
			// itself is untouched: the devScript keeps its own tty, so colours,
			// progress bars and interactive keys behave exactly as before.
			...(logPath ? { pipeTo: devServerLogSinkCommand(logPath) } : {}),
			socket,
		});
		if (stderr.trim()) {
			log.warn("runDevServer tmux stderr", { taskId: task.id.slice(0, 8), stderr: stderr.trim() });
		}
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("runDevServer tmux exited with non-zero code", { taskId: task.id.slice(0, 8), exitCode: err.exitCode, stderr: err.stderr });
		throw new Error(`tmux new-session failed (exit ${err.exitCode}): ${err.stderr || "unknown error"}`);
	}

	const taskSession = taskSessionName(task.id);
	// These shell snippets must use the app-resolved tmux binary, not bare
	// `tmux` from PATH: a client of a different version cannot talk to the
	// server it targets ("server exited unexpectedly").
	const tmuxBin = tmux.binaryPath();
	const tmuxKill = socket
		? `"${tmuxBin}" -L "${socket}" kill-session -t "${devSession}" 2>/dev/null`
		: `"${tmuxBin}" kill-session -t "${devSession}" 2>/dev/null`;
	// Re-attach loop: after a deliberate detach (e.g. wrappedScript called
	// tmux detach-client before its pane closed), re-attach if the inner
	// session still exists (e.g. a frontend pane is still running).
	// The HUP trap lets kill-pane from stopDevServer exit cleanly.
	const attachCmd = socket
		? `bash -c 'trap "${tmuxKill}" EXIT; trap "exit" HUP; while TMUX= "${tmuxBin}" -L "${socket}" has-session -t "${devSession}" 2>/dev/null; do TMUX= "${tmuxBin}" -L "${socket}" attach-session -t "${devSession}"; done'`
		: `bash -c 'trap "${tmuxKill}" EXIT; trap "exit" HUP; while TMUX= "${tmuxBin}" has-session -t "${devSession}" 2>/dev/null; do TMUX= "${tmuxBin}" attach-session -t "${devSession}"; done'`;
	// The viewer split is best-effort: the dev server itself is already up,
	// so a failed split (task session gone, pane too small) is not fatal.
	let viewerPaneId: string | null = null;
	try {
		({ paneId: viewerPaneId } = await tmux.splitWindow({
			target: anchor.tmuxTarget ?? taskSession,
			// A second server splits the column the first one holds, rather than
			// halving the agent's pane again.
			orientation: anchor.tmuxTarget ? "vertical" : "horizontal",
			size: "50%",
			printPaneId: true,
			env: paneEnv,
			cwd: worktreePath,
			command: attachCmd,
			socket,
		}));
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
	}

	if (viewerPaneId) {
		devViewerPaneIds.set(`${task.id}::${devSession}`, viewerPaneId);
		tmux.selectPane(viewerPaneId, { socket, title: `${devServerPaneTitle(server)}  (Ctrl+b Ctrl+b to control inner)` }).catch(() => {});
		tmux.setOption(taskSession, "pane-border-status", "top", { socket }).catch(() => {});
	}

	log.info("← startOneDevServer done", {
		taskId: task.id.slice(0, 8),
		server: server.name,
		...(opId ? { opId } : {}),
		devSession,
		viewerPaneId,
	});
}

/** The pane label of one server: the generic name for the default, else its own. */
function devServerPaneTitle(server: ResolvedDevServer): string {
	return server.isDefault ? auxPaneTitle("devServer") : server.title;
}

export async function checkDevServer(params: { taskId: string; projectId: string; opId?: string; server?: string }): Promise<{ running: boolean }> {
	log.info("→ checkDevServer", params);
	try {
		const ctx = await loadDevServerContext(params.projectId, params.taskId);
		// Without a name this answers for the TASK: any server up is "running",
		// which is what the header button and the board mean by it. A task that
		// declares nothing is still asked about its default server — a run started
		// before the declaration changed is still running.
		const declared = ctx.resolution.servers.map((server) => server.name);
		const names = params.server
			? [params.server]
			: declared.length > 0 ? declared : [DEFAULT_DEV_SERVER_NAME];
		let running = false;
		for (const name of names) {
			if (await isDevServerRunning(ctx.task, ctx.socket, name)) { running = true; break; }
		}
		log.info("← checkDevServer", { taskId: params.taskId, ...(params.opId ? { opId: params.opId } : {}), running });
		return { running };
	} catch {
		return { running: false };
	}
}

export async function stopDevServer(params: { taskId: string; projectId: string; opId?: string; server?: string; all?: boolean }): Promise<DevServerStatus> {
	// One id joins renderer gesture → request → aux-pane close → reap → reply. The
	// renderer's id wins when it sent one, so both sides share a single value and a
	// request lost in the bridge is an id the backend never prints (seq 1407).
	const opId = params.opId ?? crypto.randomUUID().slice(0, 8);
	log.info("→ stopDevServer", { ...params, opId });
	try {
		const ctx = await loadDevServerContext(params.projectId, params.taskId);
		const { task, socket, native } = ctx;
		const targets = params.all
			? await allDevServerNames(ctx)
			: [pickServerToStop(ctx, params.server)];
		// The run is over, so its extra env is too — a later plain `start` must not
		// silently inherit it. `restartDevServer` reads the store before it calls us.
		for (const name of targets) {
			clearDevServerEnv(task.id, name);
			clearDevServerArgs(task.id, name);
		}
		// The pane border only exists to title the tmux viewer splits.
		const clearPaneBorder = async () => {
			if (native) return;
			// A server still running keeps its own titled viewer pane, so the border
			// stays. A listing that cannot be read counts as "nothing left": leaving
			// the border on costs a stray title, leaving it off costs nothing.
			const remaining = await liveDevServerNames(task, socket).catch(() => [] as string[]);
			if (remaining.length > 0) return;
			await tmux.setOption(taskSessionName(task.id), "pane-border-status", "off", { socket });
		};

		if (targets.some((name) => isSelfHostedByTask(task.id, name))) {
			// Tearing the session down now would reap this very process before the
			// reply is written. Reply first with the projected stopped state, tear
			// down once the reply has flushed. killDevServerSession is idempotent,
			// so a replayed stop via the primary instance finishes any leftovers.
			log.warn("stopDevServer: target session hosts this instance — acking before teardown", {
				taskId: task.id.slice(0, 8),
			});
			const status = await buildDevServerStatus(ctx);
			setTimeout(() => {
				killDevServerSession(task, socket, task.worktreePath, opId, targets)
					.then(clearPaneBorder)
					.catch((err) => log.error("Deferred self-hosted dev-server teardown failed", { error: String(err) }));
			}, SELF_HOSTED_STOP_ACK_MS);
			return projectStopped(status, targets);
		}

		await killDevServerSession(task, socket, task.worktreePath, opId, targets);
		// Awaited: whether the border comes off depends on a tmux READ now, so a
		// fire-and-forget call would land after the status this stop returns.
		await clearPaneBorder().catch(() => {});
		log.info("← stopDevServer done", { opId });
		return buildDevServerStatus(ctx);
	} catch (err) {
		log.error("stopDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
		});
		throw err;
	}
}

/** The status a self-hosted stop replies with: the named servers, already down. */
function projectStopped(status: DevServerStatus, stopped: string[]): DevServerStatus {
	const servers = status.servers.map((entry) => stopped.includes(entry.name)
		? { ...entry, running: false, viewerPaneId: null, panePids: [], devPorts: [], publishedPorts: [], resourceUsage: undefined }
		: entry);
	return { ...status, servers, running: servers.some((entry) => entry.running) };
}

// stopDevServer already VERIFIES teardown (processes confirmed dead, pool
// ports confirmed released), so restart no longer needs a long blind sleep.
// A short buffer remains only for the inner tmux session/client to finish
// tearing down, avoiding redraw glitches in the viewer pane.
const DEV_SERVER_RESTART_DELAY_MS = 250;

/**
 * `env` replaces the extra env of the run being restarted; omitting it REUSES
 * that run's env. This is what makes the UI's Restart button (and a bare `dev3
 * dev-server restart`) come back on the same configuration instead of quietly
 * dropping to the project defaults. `args` follow the same rule: omitted reuses, `[]` clears.
 */
export async function restartDevServer(params: { taskId: string; projectId: string; env?: Record<string, string>; args?: string[]; server?: string; all?: boolean }): Promise<DevServerStatus> {
	log.info("→ restartDevServer", { ...params, env: params.env ? Object.keys(params.env).sort() : undefined, args: params.args?.length });
	assertScriptArgs(params.args, params.all);
	const ctx = await loadDevServerContext(params.projectId, params.taskId);
	const targets = params.all ? ctx.resolution.servers : [pickServer(ctx, params.server)];
	if (targets.some((server) => isSelfHostedByTask(params.taskId, server.name))) {
		// A self-hosted instance cannot outlive the teardown a restart requires —
		// the start half would never run (this was the "restart left the server
		// down" failure). Refuse loudly; the CLI's failover (or a re-run) routes
		// the restart to the primary instance, which can do it whole.
		throw new Error(
			"This dev server hosts the dev3 app instance serving this request "
			+ "(dev-3.0 running inside dev-3.0) — it cannot restart itself. "
			+ "Retry the command so it routes to the primary app instance, or run "
			+ "\"dev3 dev-server stop\" followed by \"dev3 dev-server start\".",
		);
	}
	// Read before the stop: `stopDevServer` clears the store, so a bare restart
	// must capture the previous run's env first.
	const envs = new Map(targets.map((server) => [
		server.name,
		params.env ?? readDevServerEnv(params.taskId, server.name),
	]));
	const argsByServer = new Map(targets.map((server) => [
		server.name,
		params.args ?? readDevServerArgs(params.taskId, server.name),
	]));
	await stopDevServer({
		taskId: params.taskId,
		projectId: params.projectId,
		...(params.all ? { all: true } : { server: targets[0].name }),
	});
	await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RESTART_DELAY_MS));
	await ensureDevServerPorts(ctx);
	for (const server of targets) {
		await startOneDevServer(ctx, server, envs.get(server.name), argsByServer.get(server.name));
	}
	refreshBoardDevServer(params.taskId);
	log.info("← restartDevServer done");
	return buildDevServerStatus(ctx);
}

export async function getDevServerStatus(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ getDevServerStatus", params);
	const ctx = await loadDevServerContext(params.projectId, params.taskId);
	const status = await buildDevServerStatus(ctx);
	log.info("← getDevServerStatus", {
		running: status.running,
		servers: status.servers.map((entry) => `${entry.name}:${entry.running ? "up" : "down"}`),
	});
	return status;
}
