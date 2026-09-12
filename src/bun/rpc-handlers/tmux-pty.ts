import { existsSync, realpathSync } from "node:fs";
import type { AgentFamily, ColumnAgentConfig, DevServerEntry, DevServerStatus, PaneSessionEntry, PermissionMode, PortInfo, Project, PtyThroughputStats, Task, TmuxLayout, TmuxSessionInfo } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import * as data from "../data";
import * as git from "../git";
import * as pty from "../pty-server";
import * as agents from "../agents";
import { getAgentAdapter } from "../../shared/agent-adapters/registry";
import { agentKey } from "../../shared/agent-adapters/families";
import { evaluateCodexModelSupport } from "../../shared/agent-model-cli-requirements";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { buildProcessTree, clearDevServerSummaryForTask, clearPortDataForTask, collectDescendants, collectTaskPids, findPortHolders, getLsofOutput, getPortsForTask, getSessionPanePids, parseLsofOutput, scanTaskPorts, schedulePortScanSoon, waitForPortsFree } from "../port-scanner";
import { classifyAgainstStartSnapshot, clearDevServerStart, clearDevServerStartsForTask, getDevServerStartSnapshot, mergePortInfos, recordDevServerStart } from "../dev-server-ports";
import {
	DEFAULT_DEV_SERVER_NAME,
	devServerPortCount,
	devServerScriptBase,
	resolveDevServerRef,
	resolveDevServers,
	splitAssignedPorts,
	type DevServerResolution,
	type ResolvedDevServer,
} from "../../shared/dev-servers";
import { clearDevServerEnv, readDevServerEnv, saveDevServerEnv } from "../dev-server-env-store";
import { sanitizeDevServerEnv } from "../../shared/dev-server-env";
import { getPidCwd, terminatePidsVerified } from "../process-reaper";
import { boostResourceMonitor, clearResourceMonitorBoost, getResourceUsage } from "../resource-monitor";
import { throughputSnapshot } from "../pty-throughput";
import { loadSettings, recordFavoriteUsages } from "../settings";
import { getUserShell } from "../shell-env";
import { agentBinaryPathOverride } from "../executable";
import { spawn } from "../spawn";
import { setupAgentHooks } from "../agent-hooks";
import { resolveResumableSessionId } from "../agent-transcripts";
import { ensureArtifactTemplateEnv } from "../artifact-template";
import {
	tmux,
	DEFAULT_TMUX_SOCKET,
	TmuxError,
	isTmuxSpawnError,
	taskSessionName,
	devServerSessionName,
	devServerSessionForTaskSession,
	isDevServerSessionOfTask,
	parseDev3SessionName,
	PANE_CWD_FORMAT,
	PANE_ID_FORMAT,
	PANE_IN_MODE_FORMAT,
	PANE_START_COMMAND_FORMAT,
	PANE_CURRENT_COMMAND_FORMAT,
	PANE_SWITCHER_FORMAT,
	WINDOW_SWITCHER_FORMAT,
	SEARCH_STATE_FORMAT,
	SESSION_OVERVIEW_FORMAT,
	ALT_CLICK_PANE_FORMAT,
	altClickIneligibleReason,
	computeAltClickKeys,
	findAltClickPane,
	validAltClickPanes,
} from "../tmux";
import { markAgentPane } from "../agent-prompt";
import { noteDev3TypedPrompt } from "../agent-typed-prompt-claims";
import { clearSetupExitCode, dev3TaskTempPath, setupExitCodePath } from "../temp-paths";
import { stopSetupFailureWatch, watchSetupFailure } from "../setup-failure-watch";
import { taskTerminalBackendIdentity } from "../task-terminal-backend";
import {
	focusNativeTaskPane,
	nativeTaskPaneCommands,
	nativeTaskPaneLayout,
	nativeTaskPanesAlive,
	nativeTaskPanesState,
	setNativeTaskPaneLayout,
} from "../native-task-panes";
import { setSplitRatio, splitCreatedBySplitting } from "../../shared/split-tree";
import { deliverAgentPrompt } from "../agent-prompt-delivery";
import { agentPromptMayHaveLanded, type AgentPromptDelivery } from "../../shared/agent-prompt-delivery";
import { handoffPrompt, prepareTaskHandoff, previewTaskHandoff } from "../conversation-handoff";
import type { HandoffPreview, SpawnAgentResult } from "../../shared/conversation-handoff-model";
import {
	auxPaneAlive,
	auxPaneTitle,
	closeAuxPane,
	closeTaskPane,
	findAuxPane,
	nativeAuxPaneShellPid,
	openAuxPane,
	splitTaskPane,
	AuxPaneUnavailableError,
	type AuxPaneHandle,
	type AuxPanePlacement,
} from "../task-aux-panes";
import { getPushMessage, isActive, AGENT_ENV_DEFAULTS, buildAgentEnv, buildAgentRetryWrapper, buildCmdScript, buildModelVersionGateWrapper, buildSetupRerunScript, buildSetupStartupWrapper, buildScriptRunnerCommand, buildTaskLifecycleEnv, shellQuote, generatedScriptLaunch, generatedScriptName, log, resolveBinaryPath, writeLaunchScript } from "./shared-pure";
import { assertPosixLaunchDialect, launchDialect } from "../../shared/platform-launch";
import { buildDevServerScript } from "../dev-server-script";
import { resetDevServerLog } from "../dev-server-log";
import { devServerLogPath, DEV_SERVER_LOG_SINK_VERB } from "../../shared/dev-server-log";
import { dev3CliExecutable } from "../task-pane-runs";
import { resolveOperationalProjectConfig } from "./settings-config";

const devViewerPaneIds = new Map<string, string>();
const fileBrowserPaneIds = new Map<string, string>();
const MAIN_AGENT_PANE_CAPTURE_ATTEMPTS = 10;
const MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS = 100;

async function waitForTaskTmuxSession(taskId: string, socket: string): Promise<void> {
	for (let attempt = 0; attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS; attempt++) {
		if (await pty.tmuxSessionExists(taskId, socket)) return;
		if (attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS));
		}
	}
	const mismatch = tmux.serverVersionMismatch();
	if (mismatch) {
		throw new Error(
			`tmux ${mismatch.clientVersion} cannot attach to the running tmux ${mismatch.serverVersion} server, ` +
			`so ${taskSessionName(taskId)} was not created. Open the tmux Sessions menu in the header, ` +
			"choose Kill All, then retry.",
		);
	}
	throw new Error(
		`tmux started but did not create session ${taskSessionName(taskId)}. ` +
			"Run `dev3 doctor` to verify the selected tmux binary, then retry.",
	);
}

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

async function collectDevServerTreePids(devSession: string, socket: string): Promise<number[]> {
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
async function reapDevServerTree(pids: number[], devSession: string): Promise<number[]> {
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
	// are excluded — they will never free and are already reported above.
	const foreignPorts = new Set(foreignHolders.map((h) => h.port));
	const waitPorts = ownedPorts.filter((port) => !foreignPorts.has(port));
	const stuckHolders = await waitForPortsFree(waitPorts, DEV_SERVER_PORT_RELEASE_WAIT_MS);
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

async function setTmuxSessionPortEnv(taskId: string, socket: string): Promise<void> {
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
 * Store the initial agent pane before Codex has emitted its first lifecycle
 * hook. Otherwise Create PR may fall back to a focused shell pane.
 *
 * Setup wrappers are excluded because they initially run in a non-agent pane;
 * their eventual agent pane is captured by the lifecycle hook or exit
 * reconciliation instead.
 */
async function persistInitialAgentPaneId(
	project: Project,
	task: Task,
	socket: string,
	paneEntry: NonNullable<Task["sessionState"]>["panes"][number],
): Promise<void> {
	for (let attempt = 0; attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS; attempt++) {
		const paneIds = await pty.listPaneIds(task.id, socket);
		if (paneIds.length === 1 && paneIds[0]) {
			await data.updateTask(project, task.id, {
				sessionState: { panes: [{ ...paneEntry, paneId: paneIds[0] }] },
			});
			void markAgentPane(socket, paneIds[0]);
			log.info("Persisted initial agent pane ID", {
				taskId: task.id.slice(0, 8),
				paneId: paneIds[0],
			});
			return;
		}

		if (attempt < MAIN_AGENT_PANE_CAPTURE_ATTEMPTS - 1) {
			await new Promise((resolve) => setTimeout(resolve, MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS));
		}
	}

	log.warn("Could not capture initial agent pane ID", { taskId: task.id.slice(0, 8) });
}

/**
 * Register worktree trust for the resolved agent's CLI before spawning it.
 * Claude trust (with MCP pre-approval) is always ensured; Codex/Gemini trust
 * only for their respective CLIs. Codex trust also re-patches ~/.codex/config.toml
 * — stripping the legacy `[profiles.dev3-*]` tables / top-level `profile = "..."`
 * selectors that codex ≥0.134 rejects and (re)writing the per-profile files. All
 * calls are idempotent and non-fatal: a failure logs and continues so a trust
 * hiccup never blocks the launch.
 *
 * MUST run before EVERY agent spawn. It used to be inlined only in the primary
 * task launch; the extra-agent (`spawnAgentInTask`) and bug-hunter panes skipped
 * it, so a spawned Codex pane launched against a stale config.toml and crashed
 * with `--profile dev3-dark cannot be used while ... contains legacy profile`.
 */
async function ensureAgentTrust(
	worktreePath: string,
	projectPath: string,
	resolvedBaseCmd: string,
	accountId?: string | null,
	foreignCode?: boolean,
	family?: AgentFamily,
): Promise<void> {
	// A worktree standing on someone else's branch gets nothing pre-granted: its
	// committed `.claude/settings.json` hooks and `.mcp.json` servers must face the
	// agent's own approval prompts, which is precisely what those prompts are for.
	// The user sees one trust dialog per reviewed branch — the intended cost.
	if (foreignCode) {
		log.info("agent trust skipped — task is marked as foreign code", { worktreePath });
		return;
	}
	// The agent adapter declares which trust routines this agent needs, in order
	// (decision 124). Every adapter includes "claude" first — dev3 has always
	// registered the worktree in ~/.claude.json (harmless superset + MCP
	// pre-approval) for every agent — then any agent-native trust (codex/gemini).
	for (const kind of getAgentAdapter(resolvedBaseCmd, family).trustKinds) {
		try {
			if (kind === "claude") await agents.ensureClaudeTrust(worktreePath, projectPath, accountId);
			else if (kind === "codex") await agents.ensureCodexTrust(worktreePath);
			else if (kind === "gemini") await agents.ensureGeminiTrust(worktreePath);
			log.info(`${kind} trust ensured`, { worktreePath });
		} catch (err) {
			log.error(`ensure ${kind} trust failed (non-fatal)`, {
				worktreePath,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
	}
}

async function applyAgentHooksToCommand(
	worktreePath: string,
	baseCommand: string,
	command: string,
	options?: {
		stopTarget?: Task["status"];
		permissionMode?: PermissionMode;
		family?: AgentFamily;
	},
): Promise<string> {
	try {
		const hookFlag = await setupAgentHooks(worktreePath, baseCommand, options);
		if (!hookFlag) return command;
		// A bare flag by design: the hook definitions themselves live in the user's
		// config.toml, because the payload that used to travel here as
		// `-c hooks={...}` never survived the Windows command line.
		const firstSeparator = command.search(/\s/);
		if (firstSeparator < 0) return `${command} ${hookFlag}`;
		return `${command.slice(0, firstSeparator)} ${hookFlag}${command.slice(firstSeparator)}`;
	} catch (err) {
		log.warn("setupAgentHooks failed (non-fatal)", {
			worktreePath,
			error: String(err),
		});
		return command;
	}
}

/**
 * Start a task's primary terminal on the native backend (seq 1292).
 *
 * Runs the SAME wrapper script the tmux path runs, handed over as an explicit
 * executable + argv so no shell re-parses it. It creates no tmux session and
 * probes none, which also means the tmux-only follow-ups are absent by
 * construction: there is no pane id to persist, session-environment already
 * arrives through the wrapper's exports, and the virtual-project side shell is a
 * multi-view feature the native backend does not serve yet.
 */
async function launchNativeTaskSession(
	project: Project,
	task: Task,
	worktreePath: string,
	runScriptPath: string,
	env: Record<string, string>,
	userShell: string,
): Promise<void> {
	// The dialect decides how the wrapper is invoked: a POSIX login shell running
	// the `.sh`, or `powershell.exe -File` running the `.ps1`.
	const launch = launchDialect().scriptLaunch(runScriptPath, { cwd: worktreePath, env, shellPath: userShell });
	await pty.createNativeTaskSession(
		task.id,
		project.id,
		worktreePath,
		{ executable: launch.executable, argv: launch.argv },
		env,
	);
	if (project.kind === "virtual") {
		log.info("Native task terminal: skipping the virtual-project side shell (single view)", {
			taskId: task.id.slice(0, 8),
		});
	}
	log.info("launchTaskPty DONE — native session created", { taskId: task.id.slice(0, 8) });
}

/** How to raise the Codex version. Deliberately not a single command: dev3 does
 *  not know which package manager put the binary there, and a `brew upgrade` line
 *  printed to an npm install is worse than naming both. */
const CODEX_UPGRADE_COMMAND = "brew upgrade codex   (npm: npm install -g @openai/codex@latest)";

/**
 * Prefix a Codex launch with the model/CLI mismatch notice when the installed
 * binary predates the model the preset pins (#1667). Returns `command`
 * untouched for every other case — another agent, an unreadable
 * `codex --version`, a model with no known floor, a third-party backend.
 */
async function applyModelVersionNotice(
	taskId: string,
	command: string,
	opts: { baseCmd: string; family: AgentFamily | undefined; launchModel: string | undefined; userShell?: string },
): Promise<string> {
	if (agentKey(opts.baseCmd, opts.family) !== "codex") return command;
	const support = evaluateCodexModelSupport(opts.launchModel, await agents.getCodexVersionCached());
	if (support.status !== "too-old") return command;

	log.warn("Codex CLI predates the launch model", {
		taskId: taskId.slice(0, 8),
		model: support.model,
		installed: support.installed,
		required: support.required,
	});
	const script = buildModelVersionGateWrapper({
		model: support.model,
		installedVersion: support.installed,
		requiredVersion: support.required,
		binaryName: "codex",
		upgradeCmd: CODEX_UPGRADE_COMMAND,
		alternativeHint: "Or pick a preset on an older model — those run on the installed version.",
		command,
	});
	const scriptPath = dev3TaskTempPath(taskId, generatedScriptName("model-version-notice"));
	await writeLaunchScript(scriptPath, script);
	return buildScriptRunnerCommand(scriptPath, { shellPath: opts.userShell });
}

export async function launchTaskPty(
	project: Project,
	task: Task,
	worktreePath: string,
	agentId?: string | null,
	configId?: string | null,
	runSetup = false,
	resume = false,
	opts?: { sessionId?: string; skipSessionPersist?: boolean; branchName?: string },
): Promise<void> {
	const sessionId = opts?.sessionId;
	const skipSessionPersist = opts?.skipSessionPersist ?? false;
	const artifactTemplateEnv = ensureArtifactTemplateEnv(project, task, worktreePath);
	log.info("launchTaskPty START", {
		taskId: task.id.slice(0, 8),
		projectId: project.id.slice(0, 8),
		worktreePath,
		agentId: agentId ?? "none",
		configId: configId ?? "none",
		runSetup,
		resume,
		sessionId: sessionId ?? "none",
		skipSessionPersist,
	});

	// Any launch supersedes the previous run's setup verdict — including the
	// "start anyway" relaunch, which is itself the answer to that verdict.
	if (task.setupFailedExitCode != null) {
		await data.updateTask(project, task.id, { setupFailedExitCode: null, setupFailedAgentRunning: null });
		task.setupFailedExitCode = null;
		task.setupFailedAgentRunning = null;
	}
	stopSetupFailureWatch(task.id);
	clearSetupExitCode(task.id);

	const ctx: agents.TemplateContext = {
		taskTitle: task.title,
		taskDescription: task.description,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};
	// The brief reaches the agent as a launch argument, and Claude Code fires
	// UserPromptSubmit for it exactly as if the user had typed it. Leave the
	// receipt here or every task's own description is recorded as the user's
	// first message.
	noteDev3TypedPrompt(task.id, ctx.taskDescription);

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;
	let resolvedAgentFamily: AgentFamily | undefined;
	let resolvedLaunchModel: string | undefined;
	let mainPaneEntry: NonNullable<Task["sessionState"]>["panes"][number] | null = null;

	try {
		// The task's persisted managed account (per-launch selector) drives which
		// CLAUDE_CONFIG_DIR / CODEX_HOME the main pane's agent env resolves to —
		// on fresh launches, retries, reopens AND resumes, so a recovered session
		// keeps running under the same account. undefined → registry default.
		const cmdOptions: agents.CommandOptions = { accountId: task.accountId };
		let freshSessionId: string | null = null;

		if (resume) {
			cmdOptions.resume = true;
			if (sessionId) cmdOptions.sessionId = sessionId;
		} else {
			// Fresh launch — always generate a new UUID.
			// Claude rejects --session-id if the UUID was already used;
			// stored session IDs are only for --resume.
			freshSessionId = crypto.randomUUID();
			cmdOptions.sessionId = freshSessionId;
		}

		if (agentId) {
			log.info("Resolving command for agent", { agentId, configId });
			const resolved = await agents.resolveCommandForAgent(agentId, configId ?? null, ctx, Object.keys(cmdOptions).length ? cmdOptions : undefined);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
			resolvedPermissionMode = resolved.config?.permissionMode;
			resolvedAgentFamily = resolved.agentFamily;
			resolvedLaunchModel = resolved.launchModel;
		} else {
			log.info("Resolving command for project", { projectName: project.name });
			const resolved = await agents.resolveCommandForProject(
				project,
				task.title,
				ctx.taskDescription,
				worktreePath,
				undefined,
				Object.keys(cmdOptions).length ? cmdOptions : undefined,
			);
			tmuxCmd = resolved.command;
			extraEnv = resolved.extraEnv;
			resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
			resolvedPermissionMode = resolved.config?.permissionMode;
			resolvedAgentFamily = resolved.agentFamily;
			resolvedLaunchModel = resolved.launchModel;
		}

		// Persist session state as pane[0] for the main agent pane.
		// Skip when reconnecting to an existing tmux session (sessionState is already correct).
		if (!skipSessionPersist) {
			const effectiveSessionId = resume ? sessionId
				: (agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null);
			// This write replaces pane[0] wholesale, so an origin store the resolver
			// still needs has to be carried across it. It belongs to one specific id:
			// a substituted id was found in this worktree's own store, so it drops.
			const priorMain = task.sessionState?.panes?.[0];
			const carriedOriginCwd = resume && effectiveSessionId && effectiveSessionId === priorMain?.sessionId
				? priorMain.sessionOriginCwd ?? undefined
				: undefined;
			const paneEntry = {
				agentCmd: resolvedBaseCmd,
				sessionId: effectiveSessionId ?? null,
				agentId: agentId ?? task.agentId,
				configId: configId ?? task.configId,
				accountId: task.accountId,
				agentFamily: resolvedAgentFamily,
				sessionOriginCwd: carriedOriginCwd,
			};
			mainPaneEntry = paneEntry;
			const sessionState = { panes: [paneEntry] };
			try {
				await data.updateTask(project, task.id, { sessionState });
				log.info("Persisted sessionState", { taskId: task.id.slice(0, 8), sessionId: paneEntry.sessionId });
			} catch (err) {
				log.error("Failed to persist sessionState (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
			}
		}

		log.info("Command resolved", { tmuxCmd, envKeys: Object.keys(extraEnv) });
	} catch (err) {
		log.error("Failed to resolve command", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}

	// Lifecycle env first so an explicit agent-config extraEnv can override it.
	// These vars reach the agent session, and — crucially — the setup script
	// below: a git-ignored hook (e.g. installed by the b44 CLI into
	// .dev3/config.local.json) only exists at the project root, so the script
	// command must be resolvable as "$DEV3_PROJECT_PATH/.dev3/<hook>.sh".
	// dev3's own defaults first, then project env (Project Settings / .dev3
	// config) — overridable by lifecycle DEV3_* vars and per-agent-config env.
	const projectEnv = await repoConfig.resolveProjectEnv(project, worktreePath, { foreignCode: task.foreignCode });
	const env = {
		...AGENT_ENV_DEFAULTS,
		...projectEnv,
		...buildTaskLifecycleEnv(project, task, worktreePath, opts?.branchName),
		...buildAgentEnv(extraEnv, task.id),
		...artifactTemplateEnv,
	};
	const userShell = getUserShell();
	const dialect = launchDialect();

	const portCount = project.portCount ?? 0;
	if (portCount > 0) {
		try {
			const ports = await portPool.allocatePorts(task.id, portCount);
			Object.assign(env, portPool.buildPortEnv(ports));
			log.info("Port env vars injected", { taskId: task.id.slice(0, 8), ports });
		} catch (err) {
			log.error("Port allocation failed (non-fatal)", {
				taskId: task.id.slice(0, 8),
				portCount,
				error: String(err),
			});
		}
	}

	if (resolvedBaseCmd && resolvedBaseCmd !== "bash") {
		const binaryName = resolvedBaseCmd.split("/").pop() ?? resolvedBaseCmd;
		const settings = await loadSettings();
		// A path cached for a previous base command must not vouch for the new
		// one; a path the user set is theirs and always counts.
		const overridePath = agentBinaryPathOverride(task.agentId ?? "", binaryName, settings.agentBinaryPaths, settings.agentCustomBinaryPaths);
		const { resolvedPath: binaryPath } = resolveBinaryPath(binaryName, overridePath);
		if (!binaryPath) {
			const allAgents = await agents.getAllAgents();
			const matchedAgent = allAgents.find((agent) => agent.baseCommand === resolvedBaseCmd || agent.baseCommand === binaryName);
			const installCmd = matchedAgent?.installCommand ?? `Install "${binaryName}" and make sure it's on your PATH`;

			log.warn("Agent binary not found, creating retry wrapper", { binaryName, installCmd });

			const originalCmdPath = dev3TaskTempPath(task.id, `original-cmd${dialect.scriptExtension}`);
			await writeLaunchScript(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

			const retryScript = buildAgentRetryWrapper({ binaryName, installCmd, originalCmdPath, shellPath: userShell });

			const retryScriptPath = dev3TaskTempPath(task.id, `agent-check${dialect.scriptExtension}`);
			await writeLaunchScript(retryScriptPath, retryScript);
			tmuxCmd = buildScriptRunnerCommand(retryScriptPath, { shellPath: userShell });
			log.info("Replaced tmuxCmd with agent-check retry wrapper");
		}
	}

	await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd, task.accountId, task.foreignCode, resolvedAgentFamily);

	const stopTarget = project.autoReviewEnabled ? "review-by-ai" : "review-by-user";
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget,
		permissionMode: resolvedPermissionMode,
		family: resolvedAgentFamily,
	});
	tmuxCmd = await applyModelVersionNotice(task.id, tmuxCmd, {
		baseCmd: resolvedBaseCmd,
		family: resolvedAgentFamily,
		launchModel: resolvedLaunchModel,
		userShell,
	});

	const nativeBackend = taskTerminalBackendIdentity(task) === "native";

	let isSetupWrapper = false;
	if (runSetup && project.setupScript.trim()) {
		const setupScriptLaunchMode = project.setupScriptLaunchMode ?? "parallel";
		const prefix = dev3TaskTempPath(task.id);
		const ext = dialect.scriptExtension;
		const setupPath = `${prefix}-setup${ext}`;
		const cmdPath = `${prefix}-cmd${ext}`;
		const startupPath = `${prefix}-startup${ext}`;

		await writeLaunchScript(setupPath, project.setupScript + "\n");
		await writeLaunchScript(cmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

		const startupScript = buildSetupStartupWrapper({
			setupPath,
			cmdPath,
			worktreePath,
			shellPath: userShell,
			nativeBackend,
			launchMode: setupScriptLaunchMode,
			setupExitPath: setupExitCodePath(task.id),
		});
		await writeLaunchScript(startupPath, startupScript);
		tmuxCmd = buildScriptRunnerCommand(startupPath, { shellPath: userShell });
		isSetupWrapper = true;
		// Which offer the pane may make is decided HERE, where the wrapper's shape is
		// known — a parallel tmux launch has already split the agent pane above, so a
		// later failure finds it alive. Native ignores launchMode and always gates.
		const agentRunning = !nativeBackend && setupScriptLaunchMode === "parallel";
		// Only this process can see the wrapper's verdict — see setup-failure-watch.
		watchSetupFailure(task.id, async (exitCode) => {
			const updated = await data.updateTask(project, task.id, {
				setupFailedExitCode: exitCode,
				setupFailedAgentRunning: agentRunning,
			});
			getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		});
	}

	const runScriptPath = dev3TaskTempPath(task.id, `run${dialect.scriptExtension}`);
	await writeLaunchScript(runScriptPath, buildCmdScript(tmuxCmd, env, { keepShell: !isSetupWrapper, shellPath: userShell }));
	const wrapperCmd = buildScriptRunnerCommand(runScriptPath, { shellPath: userShell });

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});

	// Everything above is backend-neutral on purpose: the same resolved agent
	// command, hooks, trust, account, env, ports, and wrapper script feed both
	// backends. Only the session itself differs.
	if (nativeBackend) {
		await launchNativeTaskSession(project, task, worktreePath, runScriptPath, env, userShell);
		return;
	}

	try {
		const sessionSocket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		// For virtual ops, only add the split-right shell on a FRESH session — not
		// when reconnecting to an existing one (recovery) — to avoid duplicate panes.
		let sessionPreexisted = false;
		if (project.kind === "virtual") {
			sessionPreexisted = await tmux.hasSession(taskSessionName(task.id), { socket: sessionSocket });
		}
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, sessionSocket);
		// Bun.spawn returning only proves that the client process started. A broken
		// binary or dynamic-loader failure can still make it exit immediately without
		// creating a tmux session. Gate preparation on the session itself so those
		// asynchronous launch failures are reverted and surfaced like spawn errors.
		await waitForTaskTmuxSession(task.id, sessionSocket);
		log.info("launchTaskPty DONE — PTY session created", { taskId: task.id.slice(0, 8) });
		if (!skipSessionPersist && !isSetupWrapper && mainPaneEntry) {
			await persistInitialAgentPaneId(project, task, sessionSocket, mainPaneEntry);
		}
		await setTmuxSessionPortEnv(task.id, sessionSocket);
		if (project.kind === "virtual" && !sessionPreexisted) {
			await addVirtualShellPane(task, worktreePath, sessionSocket, userShell);
		}
	} catch (err) {
		log.error("pty.createSession FAILED", {
			taskId: task.id.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

/**
 * For a virtual ("Operations") task: after the main agent PTY session is up, add
 * a split-right interactive shell pane in the same working dir, so every
 * operation has both the agent (left) and a ready shell (right). Non-fatal: any
 * failure just leaves the agent pane alone. Waits for the freshly-created tmux
 * session to come up before splitting.
 */
export async function addVirtualShellPane(task: Task, worktreePath: string, socket: string, userShell: string): Promise<void> {
	const session = taskSessionName(task.id);
	try {
		let ready = false;
		for (let i = 0; i < 40; i++) {
			if (await tmux.hasSession(session, { socket })) { ready = true; break; }
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!ready) {
			log.warn("Virtual shell pane: session never came up, skipping split", { taskId: task.id.slice(0, 8) });
			return;
		}
		let paneId: string | null = null;
		try {
			({ paneId } = await tmux.splitWindow({
				target: session,
				orientation: "horizontal",
				size: "40%",
				printPaneId: true,
				env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: worktreePath },
				cwd: worktreePath,
				command: userShell,
				socket,
			}));
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
			log.warn("Virtual shell pane split failed (non-fatal)", { taskId: task.id.slice(0, 8), exitCode: err.exitCode });
			return;
		}
		if (paneId) {
			tmux.setOption(session, "pane-border-status", "top", { socket }).catch(() => {});
			// `select-pane -t` sets a pane's title but ALSO makes it the active pane.
			// Title the shell first and the agent (pane 0) LAST, awaited in order, so
			// focus deterministically lands on the agent — not the freshly-split shell.
			await tmux.selectPane(paneId, { socket, title: "Shell" }).catch(() => {});
			await tmux.selectPane(`${session}.0`, { socket, title: "Agent" }).catch(() => {});
			log.info("Virtual shell pane created", { taskId: task.id.slice(0, 8), paneId });
		} else {
			log.warn("Virtual shell pane split failed (non-fatal)", { taskId: task.id.slice(0, 8), exitCode: 0 });
		}
	} catch (err) {
		log.warn("Virtual shell pane creation failed (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
	}
}

export async function launchColumnAgent(
	project: Project,
	task: Task,
	agentConfig: ColumnAgentConfig,
	options: { paneTitle: string; onExitCommand?: string },
): Promise<void> {
	const worktreePath = task.worktreePath;
	if (!worktreePath) {
		log.warn("launchColumnAgent: no worktreePath, skipping", { taskId: task.id.slice(0, 8) });
		return;
	}

	const { agentId, configId, prompt: rawPrompt } = agentConfig;
	const baseBranch = task.baseBranch || project.defaultBaseBranch || "main";
	// `{baseBranch}` becomes the ref this task is actually compared against — a
	// column agent told to diff against `origin/<base>` in a repo with no remote
	// reviews nothing at all.
	const prompt = rawPrompt.replace(/\{baseBranch\}/g, await git.resolveCompareRef(project.path, baseBranch));

	log.info("launchColumnAgent START", {
		taskId: task.id.slice(0, 8),
		agentId,
		configId,
		paneTitle: options.paneTitle,
	});

	const socket = pty.getSessionSocket(task.id);
	const tmuxSession = taskSessionName(task.id);

	const ctx: agents.TemplateContext = {
		taskTitle: `${options.paneTitle}: ${task.title}`,
		taskDescription: prompt,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};
	// A column agent runs in the same worktree, so its own launch prompt reaches
	// the prompt-submit hook under this task's id too.
	noteDev3TypedPrompt(task.id, prompt);

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;
	let resolvedAgentFamily: AgentFamily | undefined;

	try {
		const resolved = await agents.resolveCommandForAgent(agentId, configId, ctx, { skipSystemPrompt: true });
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedPermissionMode = resolved.config?.permissionMode;
		resolvedAgentFamily = resolved.agentFamily;
	} catch (err) {
		log.error("launchColumnAgent: failed to resolve command", { error: String(err) });
		throw err;
	}
	await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd, undefined, task.foreignCode, resolvedAgentFamily);
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		permissionMode: resolvedPermissionMode,
		family: resolvedAgentFamily,
	});

	const env = {
		...AGENT_ENV_DEFAULTS,
		...(await repoConfig.resolveProjectEnv(project, worktreePath, { foreignCode: task.foreignCode })),
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, worktreePath),
	};
	const scriptPath = dev3TaskTempPath(task.id, generatedScriptName("col-agent"));
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env, {
		paneTitle: options.paneTitle,
		onExitCommand: options.onExitCommand,
	}));

	// The seam owns placement and dedup: the `columnAgent` purpose keeps at most one
	// live pane per task, re-found by the command it was launched with, so a repeated
	// activation REPLACES the review agent — and refuses to launch if it cannot prove
	// the old one is gone. A native task never reaches tmux from here.
	const handle = await openAuxPane({
		task,
		purpose: "columnAgent",
		placement: "right",
		size: "40%",
		cwd: worktreePath,
		env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: worktreePath },
		socket,
		title: options.paneTitle,
		tmuxCommand: `bash "${scriptPath}"`,
		nativeLaunch: generatedScriptLaunch(scriptPath),
	});

	// tmux hands focus to the freshly split pane; the agent (pane 0) keeps it, as it
	// always has. The native path restores focus inside the seam.
	if (handle.backend === "tmux") {
		try {
			await tmux.selectPane(`${tmuxSession}:.0`, { socket, bestEffort: true });
		} catch {}
	}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8), backend: handle.backend, paneId: handle.paneId });
}

export function cleanupTaskTmuxState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	// One viewer pane per dev server, all keyed under this task.
	for (const key of [...devViewerPaneIds.keys()]) {
		if (key.startsWith(`${taskId}::`)) devViewerPaneIds.delete(key);
	}
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
 * `env` is the caller's own extra environment (`dev3 dev-server start --env
 * KEY=VALUE`). Absent means "no extra env for this run" and CLEARS whatever the
 * previous run stored — a start defines its configuration whole. Only
 * `restartDevServer` carries the previous set forward.
 *
 * `server` names ONE declared server; `all` starts every one of them. Neither
 * means the default server, exactly as before.
 */
export async function runDevServer(params: { taskId: string; projectId: string; opId?: string; env?: Record<string, string>; server?: string; all?: boolean }): Promise<DevServerStatus> {
	// Echo the renderer's correlation id so a click that never reached a handler is
	// distinguishable from one that did (seq 1407).
	// Values redacted: an extra env pair can carry a secret and this log is a file.
	log.info("→ runDevServer", { ...params, env: params.env ? Object.keys(params.env).sort() : undefined });
	try {
		const ctx = await loadDevServerContext(params.projectId, params.taskId);
		if (ctx.resolution.servers.length === 0) throw new Error("No dev script configured");
		if (!ctx.task.worktreePath) throw new Error("Task has no worktree");
		if (ctx.resolution.errors.length > 0) throw new Error(ctx.resolution.errors.join("; "));

		const targets = params.all ? ctx.resolution.servers : [pickServer(ctx, params.server)];
		await ensureDevServerPorts(ctx);
		for (const server of targets) {
			await startOneDevServer(ctx, server, params.env, params.opId);
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
	opId?: string,
): Promise<void> {
	const { task, project, native, socket } = ctx;
	const worktreePath = task.worktreePath!;
	// Never trust the caller: `devServer.start` is reachable from the CLI, the
	// renderer, and any other socket client, and only the CLI validates.
	const callerEnv = sanitizeDevServerEnv(env);
	saveDevServerEnv(task.id, server.name, callerEnv);

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
	const preStartConflicts = await findPortHolders(ownPorts);
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

async function checkDevServer(params: { taskId: string; projectId: string; opId?: string; server?: string }): Promise<{ running: boolean }> {
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
		for (const name of targets) clearDevServerEnv(task.id, name);
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
 * dropping to the project defaults.
 */
export async function restartDevServer(params: { taskId: string; projectId: string; env?: Record<string, string>; server?: string; all?: boolean }): Promise<DevServerStatus> {
	log.info("→ restartDevServer", { ...params, env: params.env ? Object.keys(params.env).sort() : undefined });
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
	await stopDevServer({
		taskId: params.taskId,
		projectId: params.projectId,
		...(params.all ? { all: true } : { server: targets[0].name }),
	});
	await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RESTART_DELAY_MS));
	await ensureDevServerPorts(ctx);
	for (const server of targets) {
		await startOneDevServer(ctx, server, envs.get(server.name));
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

async function openFileBrowser(params: { taskId: string; projectId: string }): Promise<{ notInstalled: true; installCommand: string; linuxHint?: boolean } | void> {
	log.info("→ openFileBrowser", params);
	try {
		const yaziCheckProc = spawn(["which", "yazi"], { stdout: "pipe", stderr: "pipe" });
		const yaziCheckExit = await yaziCheckProc.exited;
		if (yaziCheckExit !== 0) {
			const brewCmd = "brew install yazi ffmpegthumbnailer sevenzip jq poppler fd ripgrep fzf zoxide imagemagick chafa";
			const installCommand = process.platform === "win32"
				? "scoop install yazi ffmpeg 7zip jq poppler fd ripgrep fzf zoxide imagemagick chafa"
				: brewCmd;
			const linuxHint = process.platform === "linux";
			log.info("← openFileBrowser: yazi not installed", { platform: process.platform });
			return { notInstalled: true, installCommand, linuxHint };
		}

		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		if (!task.worktreePath) throw new Error("Task has no worktree");

		const tmuxSession = taskSessionName(task.id);
		const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		const existingPane = fileBrowserPaneIds.get(task.id);
		if (existingPane) {
			await tmux.killPane(existingPane, { socket, bestEffort: true });
			fileBrowserPaneIds.delete(task.id);
			log.info("← openFileBrowser: toggled off (killed pane)", { taskId: task.id.slice(0, 8), paneId: existingPane });
			return;
		}

		// A failed pane listing (session gone mid-toggle) falls through to the
		// split below, exactly like an empty listing did.
		let paneRows: Array<{ paneId: string; currentCommand: string }> = [];
		try {
			paneRows = await tmux.listPanes(PANE_CURRENT_COMMAND_FORMAT, { target: tmuxSession, socket });
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
		}
		for (const row of paneRows) {
			if (!row.currentCommand.includes("yazi")) continue;
			await tmux.killPane(row.paneId, { socket, bestEffort: true });
			log.info("← openFileBrowser: toggled off (found running yazi)", { taskId: task.id.slice(0, 8), paneId: row.paneId });
			return;
		}

		let paneId: string | null;
		try {
			({ paneId } = await tmux.splitWindow({
				target: tmuxSession,
				orientation: "vertical",
				size: "30%",
				printPaneId: true,
				cwd: task.worktreePath,
				command: "yazi",
				socket,
			}));
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
			log.error("openFileBrowser tmux failed", { taskId: task.id.slice(0, 8), exitCode: err.exitCode, stderr: err.stderr });
			throw new Error(`tmux split-window failed: ${err.stderr || "unknown error"}`);
		}

		if (paneId) {
			fileBrowserPaneIds.set(task.id, paneId);
			log.info("← openFileBrowser done", { paneId });
		} else {
			log.info("← openFileBrowser done (no pane id captured)");
		}
	} catch (err) {
		log.error("openFileBrowser FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

async function getTerminalPreview(params: { taskId: string }): Promise<string | null> {
	return pty.capturePane(params.taskId);
}

async function checkWorktreeExists(params: { path: string }): Promise<boolean> {
	return existsSync(params.path);
}

async function getPtyUrl(params: { taskId: string; resume?: boolean }) {
	log.info("→ getPtyUrl", {
		taskId: params.taskId,
		hasExistingSession: pty.hasSession(params.taskId),
		hasDeadSession: pty.hasDeadSession(params.taskId),
		ptyPort: pty.getPtyPort(),
	});

	// If resuming and the session is dead (proc exited but still in map),
	// destroy it so launchTaskPty recreates it with the resume flag.
	if (params.resume && pty.hasDeadSession(params.taskId)) {
		log.info("Resume requested on dead session — destroying to force recreation", {
			taskId: params.taskId.slice(0, 8),
		});
		await pty.destroySessionAwaited(params.taskId);
	}

	// If session is in memory (alive or dead), verify the backend's session still
	// exists. When the tmux server (or a native host) is killed externally, our
	// handle may or may not have noticed yet — the backend is the ground truth.
	if (pty.hasSession(params.taskId) && !pty.isNativeSessionSettling(params.taskId)) {
		const alive = pty.getSessionBackend(params.taskId) === "native"
			? await nativeTaskPanesAlive(params.taskId)
			: await pty.tmuxSessionExists(params.taskId, pty.getSessionSocket(params.taskId));
		if (!alive) {
			log.info("Session in memory but the backend session is gone — destroying for recovery", {
				taskId: params.taskId.slice(0, 8),
			});
			await pty.destroySessionAwaited(params.taskId);
		}
	}

	// If no PTY session in memory, try to recreate it from persisted task data
	if (!pty.hasSession(params.taskId)) {
		log.info("No PTY session in memory, attempting to restore", {
			taskId: params.taskId.slice(0, 8),
		});

		const { task: foundTask, project: foundProject } = await findTaskAcrossProjects(params.taskId);

		// A hibernated task is never auto-restored: opening it must not undo the
		// hibernation. Report the frozen state so the renderer offers an explicit
		// wake (plain shell or resume the agent's conversation) instead.
		if (foundTask?.hibernated) {
			log.info("Hibernated task — offering an explicit wake instead of restoring", {
				taskId: params.taskId.slice(0, 8),
			});
			return {
				recoverable: true as const,
				sessionState: foundTask.sessionState ?? { panes: [] },
				hibernated: true as const,
			};
		}

		if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
			const identity = taskTerminalBackendIdentity(foundTask);
			const sessionAlive = identity === "native"
				? await nativeTaskPanesAlive(params.taskId)
				: await pty.tmuxSessionExists(params.taskId, foundTask.tmuxSocket ?? DEFAULT_TMUX_SOCKET);

			if (sessionAlive && identity === "native") {
				// The host and shell outlived this app process — rebind to them. This
				// must never go through launchTaskPty: creating a second session for a
				// live one is exactly the double-spawn the seam refuses.
				try {
					await pty.reattachNativeTaskSession(params.taskId, foundProject.id, foundTask.worktreePath);
					log.info("Reattached to existing native session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to reattach to native session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
			} else if (sessionAlive) {
				// Tmux session exists — just reconnect (no resume needed).
				// Skip session persist so we don't overwrite the real session ID.
				try {
					// Virtual boards have no git repo config to resolve — pass through.
					const resolvedProject = foundProject.kind === "virtual"
						? foundProject
						: await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false, { skipSessionPersist: true });
					log.info("Reconnected to existing tmux session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to reconnect to tmux session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
			} else if (foundTask.sessionState?.panes?.length) {
				// No tmux session but we have stored pane sessions — offer recovery
				log.info("Recoverable session detected", {
					taskId: params.taskId.slice(0, 8),
					paneCount: foundTask.sessionState.panes.length,
				});
				return { recoverable: true as const, sessionState: foundTask.sessionState };
			} else {
				// No tmux, no session state — launch fresh
				try {
					const resolvedProject = foundProject.kind === "virtual"
						? foundProject
						: await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false);
					log.info("Launched fresh PTY session", { taskId: params.taskId.slice(0, 8) });
					await markTerminalAttached(foundProject, foundTask);
				} catch (err) {
					log.error("Failed to launch fresh PTY session", { taskId: params.taskId.slice(0, 8), error: String(err) });
				}
			}
		} else {
			log.warn("Cannot restore PTY session: task not active or no worktree", {
				taskId: params.taskId.slice(0, 8),
				found: !!foundTask,
				status: foundTask?.status ?? "not found",
				worktreePath: foundTask?.worktreePath ?? "none",
				isActiveStatus: foundTask ? isActive(foundTask.status) : false,
			});
		}
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← getPtyUrl", { url, sessionExists: pty.hasSession(params.taskId) });
	return { url };
}

/** Find a task by ID across all projects (git AND virtual/Operations boards). */
async function findTaskAcrossProjects(taskId: string): Promise<{ task: Task | null; project: Project | null }> {
	try {
		// Virtual boards live in a separate file — they MUST be scanned too, or an
		// active operation's PTY can never be restored (the task "isn't found").
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				const task = await data.getTask(project, taskId);
				return { task, project };
			} catch {
				// task not in this project
			}
		}
	} catch (err) {
		log.error("Failed to load projects during task search", {
			taskId: taskId.slice(0, 8),
			error: String(err),
		});
	}
	return { task: null, project: null };
}

/**
 * Clear the hibernation flag as part of a successful wake. Waking is always an
 * explicit act performed inside the task, so this only ever runs from the two
 * buttons on the wake screen — never from merely opening the terminal.
 */
async function wakeIfHibernated(project: Project, task: Task): Promise<void> {
	if (!task.hibernated) return;
	// Imported lazily: the lifecycle service pulls in the electrobun-heavy executor,
	// and this module must stay importable without it.
	const { dispatchLifecycleEvent } = await import("../lifecycle/service");
	await dispatchLifecycleEvent(project.id, task.id, { type: "wakeRequested" }, { project, task });
}

/**
 * Tell the lifecycle machine a terminal is live again. Only ever corrects a
 * runtime the boot probe wrote as `idle` because the session died with the app —
 * without it a resumed task would keep rendering as disconnected forever.
 */
async function markTerminalAttached(project: Project, task: Task): Promise<void> {
	try {
		// Lazily imported for the same reason as in `wakeIfHibernated`.
		const { dispatchLifecycleEvent } = await import("../lifecycle/service");
		await dispatchLifecycleEvent(project.id, task.id, { type: "terminalAttached" }, { project, task });
	} catch (err) {
		log.warn("Failed to mark terminal attached (non-fatal)", {
			taskId: task.id.slice(0, 8),
			error: String(err),
		});
	}
}

/**
 * Resume pointer for one pane, healed against the transcripts on disk. A stored
 * id whose transcript is gone would kill the pane on `--resume`; the newest
 * surviving conversation for that worktree is the right thing to reopen instead
 * (decision 189). Returns null to let the agent pick its own latest session.
 */
function resolveResumeTarget(task: Task, pane: PaneSessionEntry, label: string): string | null {
	const target = resolveResumableSessionId(
		pane.agentCmd,
		task.worktreePath ?? "",
		pane.sessionId,
		undefined,
		pane.agentFamily ?? undefined,
		pane.sessionOriginCwd,
	);
	if (target.substituted) {
		log.warn("Stored session id has no transcript — resuming the newest conversation instead", {
			taskId: task.id.slice(0, 8),
			pane: label,
			stored: pane.sessionId,
			using: target.sessionId ?? "agent-latest",
		});
	}
	return target.sessionId;
}

async function resumeTask(params: { taskId: string }): Promise<string> {
	log.info("→ resumeTask", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot resume: task ${params.taskId} not found or has no worktree`);
	}
	const panes = task.sessionState?.panes;
	if (!panes?.length) {
		throw new Error(`Cannot resume: task ${params.taskId} has no stored pane sessions`);
	}
	await wakeIfHibernated(project, task);

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		await pty.destroySessionAwaited(params.taskId);
	}

	// Launch main pane (panes[0]) with resume
	const main = panes[0];
	const mainResume = resolveResumeTarget(task, main, "main");
	const resolvedProject = project.kind === "virtual"
		? project
		: await repoConfig.resolveProjectConfig(project, task.worktreePath);
	await launchTaskPty(
		resolvedProject,
		task,
		task.worktreePath,
		main.agentId,
		main.configId,
		false,
		true,
		mainResume ? { sessionId: mainResume } : undefined,
	);

	// Resume extra panes (panes[1..]) via split-window.
	// Wait for the tmux session to be ready before splitting.
	if (panes.length > 1 && taskTerminalBackendIdentity(task) === "tmux") {
		const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		const maxWaitMs = 3000;
		const pollMs = 100;
		let waited = 0;
		while (!(await pty.tmuxSessionExists(params.taskId, socket)) && waited < maxWaitMs) {
			await new Promise(r => setTimeout(r, pollMs));
			waited += pollMs;
		}
		if (!(await pty.tmuxSessionExists(params.taskId, socket))) {
			log.warn("Tmux session not ready after wait — skipping extra pane resume", { taskId: params.taskId.slice(0, 8) });
		} else {
			const ctx: agents.TemplateContext = {
				taskTitle: task.title,
				taskDescription: "",
				projectName: project.name,
				projectPath: project.path,
				worktreePath: task.worktreePath,
			};
			const paneIdUpdates: Array<{ index: number; paneId: string }> = [];
			for (let i = 1; i < panes.length; i++) {
				const pane = panes[i];
				try {
					const paneResume = resolveResumeTarget(task, pane, `pane ${i}`);
					const cmdOpts: agents.CommandOptions = { resume: true, accountId: pane.accountId };
					if (paneResume) cmdOpts.sessionId = paneResume;
					let resumeCmd: string;
					let resumeBaseCmd = pane.agentCmd;
					// The pane's own snapshot is the fallback: without an agent record
					// there is nothing but the command string, and guessing the CLI from
					// a renamed binary is exactly what broke resume.
					let resumeAgentFamily: AgentFamily | undefined = pane.agentFamily ?? undefined;
					let extraEnv: Record<string, string> = {};
					if (pane.agentId) {
						const resolved = await agents.resolveCommandForAgent(pane.agentId, pane.configId, ctx, cmdOpts);
						resumeCmd = resolved.command;
						extraEnv = resolved.extraEnv;
						resumeBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || pane.agentCmd;
						resumeAgentFamily = resolved.agentFamily ?? resumeAgentFamily;
					} else {
						resumeCmd = agents.buildResumeCommand(pane.agentCmd, paneResume ?? undefined, resumeAgentFamily) ?? pane.agentCmd;
					}
					await ensureAgentTrust(task.worktreePath, project.path, resumeBaseCmd, pane.accountId, task.foreignCode, resumeAgentFamily);
					resumeCmd = await applyAgentHooksToCommand(task.worktreePath, resumeBaseCmd, resumeCmd, {
						stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
						family: resumeAgentFamily,
					});
					const scriptPath = dev3TaskTempPath(params.taskId, `resume-pane-${i}.sh`);
					await writeLaunchScript(scriptPath, buildCmdScript(resumeCmd, extraEnv, { keepShell: true }));
					const wrappedCmd = `bash "${scriptPath}"`;
					const newPaneId = await pty.splitAndRunCommand(params.taskId, socket, wrappedCmd, task.worktreePath);
					if (newPaneId) paneIdUpdates.push({ index: i, paneId: newPaneId });
					log.info("Resumed extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, paneId: newPaneId, command: resumeCmd.slice(0, 100) });
				} catch (err) {
					log.warn("Failed to resume extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, error: String(err) });
				}
			}
			// Update pane IDs in sessionState (pane IDs change across tmux server restarts)
			if (paneIdUpdates.length > 0) {
				try {
					const freshTask = await data.getTask(project, params.taskId);
					const updatedPanes = [...(freshTask.sessionState?.panes ?? [])];
					for (const { index, paneId } of paneIdUpdates) {
						if (updatedPanes[index]) updatedPanes[index] = { ...updatedPanes[index], paneId };
					}
					await data.updateTask(project, params.taskId, { sessionState: { panes: updatedPanes } });
				} catch (err) {
					log.warn("Failed to update pane IDs after resume (non-fatal)", { error: String(err) });
				}
			}
		}
	}

	await markTerminalAttached(project, task);

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← resumeTask", { url });
	return url;
}

async function restartTask(params: { taskId: string }): Promise<string> {
	log.info("→ restartTask", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot restart: task ${params.taskId} not found or has no worktree`);
	}
	await wakeIfHibernated(project, task);

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		await pty.destroySessionAwaited(params.taskId);
	}

	// Remember agent info before clearing
	const mainPane = task.sessionState?.panes?.[0];
	const agentId = mainPane?.agentId ?? task.agentId;
	const configId = mainPane?.configId ?? task.configId;

	// Clear old session state — a new one will be generated by launchTaskPty
	await data.updateTask(project, task.id, { sessionState: null });

	const resolvedProject = project.kind === "virtual"
		? project
		: await repoConfig.resolveProjectConfig(project, task.worktreePath);
	await launchTaskPty(
		resolvedProject,
		task,
		task.worktreePath,
		agentId,
		configId,
		false,
		false,
	);

	await markTerminalAttached(project, task);

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← restartTask", { url });
	return url;
}

/** Forget a setup verdict and tell every viewer, so the notice cannot come back. */
async function clearSetupFailure(project: Project, task: Task): Promise<void> {
	stopSetupFailureWatch(task.id);
	clearSetupExitCode(task.id);
	const updated = await data.updateTask(project, task.id, { setupFailedExitCode: null, setupFailedAgentRunning: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

async function dismissSetupFailure(params: { taskId: string }): Promise<void> {
	log.info("→ dismissSetupFailure", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot dismiss: task ${params.taskId} not found`);
	await clearSetupFailure(project, task);
}

async function dismissCloneFailures(params: { taskId: string }): Promise<void> {
	log.info("→ dismissCloneFailures", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot dismiss: task ${params.taskId} not found`);
	const updated = await data.updateTask(project, task.id, { cloneFailures: null });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}

async function rerunSetupScript(params: { taskId: string }): Promise<void> {
	log.info("→ rerunSetupScript", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project) throw new Error(`Cannot re-run setup: task ${params.taskId} not found`);
	if (!task.worktreePath) throw new Error("Task has no worktree");

	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath, { foreignCode: task.foreignCode });
	if (!resolved.setupScript.trim()) throw new Error("No setup script configured");

	const prefix = dev3TaskTempPath(task.id);
	const ext = launchDialect().scriptExtension;
	const setupPath = `${prefix}-setup${ext}`;
	const rerunPath = `${prefix}-setup-rerun${ext}`;
	await writeLaunchScript(setupPath, resolved.setupScript + "\n");

	// Clear BEFORE the pane opens: the click is the answer to the old verdict, and
	// the fresh watch below is what brings the notice back if this run fails too.
	await clearSetupFailure(project, task);

	const shellPath = getUserShell();
	await writeLaunchScript(rerunPath, buildSetupRerunScript({ setupPath, shellPath, setupExitPath: setupExitCodePath(task.id) }));

	const env = {
		...(resolved.env ?? {}),
		...buildTaskLifecycleEnv(project, task, task.worktreePath),
	};
	const ports = portPool.getPortAssignments(task.id);
	if (ports.length > 0) Object.assign(env, portPool.buildPortEnv(ports));

	// A re-run starts no agent, so the answer is the same one the launch computed —
	// and it must be recomputed rather than read back from the task, which a
	// dismissal may already have cleared.
	const agentRunning = taskTerminalBackendIdentity(task) !== "native"
		&& (resolved.setupScriptLaunchMode ?? "parallel") === "parallel";
	watchSetupFailure(task.id, async (exitCode) => {
		const updated = await data.updateTask(project, task.id, {
			setupFailedExitCode: exitCode,
			setupFailedAgentRunning: agentRunning,
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
	});

	const handle = await openAuxPane({
		task,
		purpose: "setupRerun",
		placement: "below",
		size: "35%",
		cwd: task.worktreePath,
		env,
		socket: task.tmuxSocket ?? DEFAULT_TMUX_SOCKET,
		title: auxPaneTitle("setupRerun"),
		tmuxCommand: buildScriptRunnerCommand(rerunPath, { shellPath }),
		nativeLaunch: generatedScriptLaunch(rerunPath),
	});
	log.info("← rerunSetupScript done", { taskId: params.taskId.slice(0, 8), paneId: handle.paneId });
}

async function getProjectPtyUrl(params: { projectId: string }): Promise<string> {
	const sessionKey = `project-${params.projectId}`;
	log.info("→ getProjectPtyUrl", {
		projectId: params.projectId.slice(0, 8),
		hasExistingSession: pty.hasSession(sessionKey),
	});

	if (pty.hasDeadSession(sessionKey)) {
		log.info("Dead project terminal session — destroying to recreate", {
			projectId: params.projectId.slice(0, 8),
		});
		pty.destroySession(sessionKey);
	}

	if (!pty.hasSession(sessionKey)) {
		const project = await data.getProject(params.projectId);
		// Virtual ("Operations") boards have no repo and no stable project folder
		// (the synthetic ~/.dev3.0/ops/<slug> path is created lazily per-task). A
		// project terminal there is meaningless and would otherwise open a shell in
		// dev3's internal data dir — reject it explicitly. The UI hides the
		// affordance for virtual boards; this is the backend backstop.
		if (project.kind === "virtual") {
			throw new Error("Project terminal is not available for Operations boards");
		}
		if (!existsSync(project.path)) {
			throw new Error(`Project path does not exist: ${project.path}`);
		}
		const env = await repoConfig.resolveProjectEnv(project, project.path);
		pty.createSession(sessionKey, params.projectId, project.path, getUserShell(), env, DEFAULT_TMUX_SOCKET, "project");
	}

	const url = `ws://localhost:${pty.getPtyPort()}?session=${sessionKey}`;
	log.info("← getProjectPtyUrl", { url });
	return url;
}

async function destroyProjectTerminal(params: { projectId: string }): Promise<void> {
	const sessionKey = `project-${params.projectId}`;
	log.info("→ destroyProjectTerminal", { projectId: params.projectId.slice(0, 8) });
	pty.destroySession(sessionKey);
	log.info("← destroyProjectTerminal done");
}

async function getTaskPorts(params: { taskId: string }): Promise<PortInfo[]> {
	log.info("→ getTaskPorts", { taskId: params.taskId.slice(0, 8) });
	const ports = getPortsForTask(params.taskId);
	log.info("← getTaskPorts", { taskId: params.taskId.slice(0, 8), count: ports.length });
	return ports;
}

async function getPortAllocations(params: { taskId: string }): Promise<number[]> {
	return portPool.getPortAssignments(params.taskId);
}

async function listTmuxSessions(): Promise<TmuxSessionInfo[]> {
	log.debug("→ listTmuxSessions");

	let sessionRows: Array<{ name: string; windowCount: number; createdAt: number; cwd: string }>;
	try {
		sessionRows = await tmux.listSessions(SESSION_OVERVIEW_FORMAT);
	} catch {
		log.debug("← listTmuxSessions (no tmux server or error)");
		return [];
	}

	const taskShortIds = new Set<string>();
	const projectShortIds = new Set<string>();
	const rawSessions: Array<{
		name: string;
		cwd: string;
		createdAt: number;
		windowCount: number;
		isCleanup: boolean;
		isProjectTerminal: boolean;
		shortId: string;
	}> = [];

	for (const row of sessionRows) {
		const parsed = parseDev3SessionName(row.name);
		if (!parsed) continue;
		if (parsed.kind === "dev-server") continue;
		// Ignore a stale single home terminal session from an older app version
		// (the home terminal was replaced by the Quick-shell operation).
		if (row.name === "dev3-home") continue;

		const isCleanup = parsed.kind === "cleanup";
		const isProjectTerminal = parsed.kind === "project-terminal";

		rawSessions.push({
			name: row.name,
			cwd: row.cwd || "",
			createdAt: row.createdAt,
			windowCount: row.windowCount || 1,
			isCleanup,
			isProjectTerminal,
			shortId: parsed.shortId,
		});

		if (isProjectTerminal) {
			projectShortIds.add(parsed.shortId);
		} else {
			taskShortIds.add(parsed.shortId);
		}
	}

	if (rawSessions.length === 0) {
		log.debug("← listTmuxSessions", { count: 0 });
		return [];
	}

	const taskMap = new Map<string, { title: string; taskId: string; projectId: string }>();
	const projectMap = new Map<string, { name: string; projectId: string }>();
	try {
		// Include virtual ("Operations") projects so their operation sessions resolve too.
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		const pendingTaskIds = new Set(taskShortIds);

		for (const project of projects) {
			const shortProjectId = project.id.slice(0, 8);
			if (projectShortIds.has(shortProjectId)) {
				projectMap.set(shortProjectId, { name: project.name, projectId: project.id });
			}

			if (pendingTaskIds.size === 0) {
				if (projectMap.size === projectShortIds.size) break;
				continue;
			}

			const tasks = await data.loadTasks(project);
			for (const task of tasks) {
				const shortTaskId = task.id.slice(0, 8);
				if (!pendingTaskIds.has(shortTaskId)) continue;
				taskMap.set(shortTaskId, {
					title: getTaskTitle(task),
					taskId: task.id,
					projectId: project.id,
				});
				pendingTaskIds.delete(shortTaskId);
			}

			if (pendingTaskIds.size === 0 && projectMap.size === projectShortIds.size) break;
		}
	} catch {}

	const sessions: TmuxSessionInfo[] = [];
	for (const rawSession of rawSessions) {
		const { name, cwd, windowCount, createdAt, isCleanup, isProjectTerminal, shortId } = rawSession;
		if (isProjectTerminal) {
			const projectInfo = projectMap.get(shortId);
			sessions.push({
				name,
				cwd,
				createdAt,
				windowCount,
				isCleanup: false,
				isProjectTerminal: true,
				projectName: projectInfo?.name,
				projectId: projectInfo?.projectId,
			});
			continue;
		}

		const taskInfo = taskMap.get(shortId);

		sessions.push({
			name,
			cwd,
			createdAt,
			windowCount,
			isCleanup,
			taskTitle: taskInfo?.title,
			taskId: taskInfo?.taskId,
			projectId: taskInfo?.projectId,
			ports: taskInfo?.taskId ? getPortsForTask(taskInfo.taskId) : undefined,
			resourceUsage: taskInfo?.taskId ? getResourceUsage(taskInfo.taskId) : undefined,
		});
	}

	sessions.sort((a, b) => b.createdAt - a.createdAt);
	log.debug("← listTmuxSessions", { count: sessions.length });
	return sessions;
}

/**
 * Renewed on a heartbeat while the tmux sessions popover is open, cleared when
 * it closes. See the boost's own TTL — this handler never has to be trusted to
 * send the `false`.
 */
async function setResourceMonitorBoost(params: { active: boolean }): Promise<void> {
	if (params.active) boostResourceMonitor();
	else clearResourceMonitorBoost();
}

async function killTmuxSession(params: { sessionName: string }): Promise<void> {
	log.info("→ killTmuxSession", { sessionName: params.sessionName });
	if (!params.sessionName.startsWith("dev3-")) {
		throw new Error("Can only kill dev3-* sessions");
	}
	try {
		await tmux.killSession(params.sessionName);
	} catch (err) {
		const stderr = err instanceof TmuxError ? err.stderr : String(err);
		log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr });
		throw new Error(`Failed to kill session: ${stderr}`);
	}

	if (!params.sessionName.startsWith("dev3-dev-")) {
		const devSession = devServerSessionForTaskSession(params.sessionName);
		// Same orphaned-children problem as the Stop button: snapshot the dev
		// server's process tree before tearing the session down, then reap it
		// with verification. (No full task ID here, so the port-ownership orphan
		// sweep is skipped — the tree reap covers the common case.)
		const treePids = await collectDevServerTreePids(devSession, DEFAULT_TMUX_SOCKET);
		await tmux.killSession(devSession, { bestEffort: true });
		await reapDevServerTree(treePids, devSession);
		log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
	}

	log.info("← killTmuxSession done", { sessionName: params.sessionName });
}

export async function tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV"; force?: boolean }): Promise<void> {
	log.info("→ tmuxAction", { taskId: params.taskId.slice(0, 8), action: params.action, force: params.force === true });
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	// For killPane, capture the active pane ID before killing — kill-pane
	// does NOT trigger tmux's pane-exited hook, so we must clean up sessionState here.
	// By default refuse to kill the last remaining pane in the session — otherwise an
	// accidental click on the red button takes down the agent's own pane. The frontend
	// can pass `force: true` after explicit user confirmation to allow it.
	let killedPaneId: string | null = null;
	if (params.action === "killPane") {
		if (!params.force) {
			try {
				const paneCount = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
				if (paneCount <= 1) {
					log.info("tmuxAction killPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
					return;
				}
			} catch { /* best effort — if counting fails, fall through to the normal kill */ }
		}

		try {
			killedPaneId = await tmux.activePaneId(tmuxSession, { socket });
		} catch { /* best effort */ }
	}

	try {
		switch (params.action) {
			case "splitH":
				await tmux.splitWindow({ target: tmuxSession, orientation: "vertical", cwd: PANE_CWD_FORMAT, socket });
				break;
			case "splitV":
				await tmux.splitWindow({ target: tmuxSession, orientation: "horizontal", cwd: PANE_CWD_FORMAT, socket });
				break;
			case "zoom":
				await tmux.toggleZoom(tmuxSession, { socket });
				break;
			case "killPane":
				await tmux.killPane(tmuxSession, { socket });
				break;
			case "nextPane":
				await tmux.selectPane(`${tmuxSession}:.+`, { socket });
				break;
			case "prevPane":
				await tmux.selectPane(`${tmuxSession}:.-`, { socket });
				break;
			case "newWindow":
				await tmux.newWindow({ target: tmuxSession, cwd: PANE_CWD_FORMAT, socket });
				break;
			case "nextLayout":
				await tmux.nextLayout(tmuxSession, { socket });
				break;
			case "layoutTiled":
				await tmux.selectLayout(tmuxSession, "tiled", { socket });
				break;
			case "layoutEvenH":
				await tmux.selectLayout(tmuxSession, "even-vertical", { socket });
				break;
			case "layoutEvenV":
				await tmux.selectLayout(tmuxSession, "even-horizontal", { socket });
				break;
			case "layoutMainH":
				await tmux.selectLayout(tmuxSession, "main-horizontal", { socket });
				break;
			case "layoutMainV":
				await tmux.selectLayout(tmuxSession, "main-vertical", { socket });
				break;
		}
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("tmuxAction failed", { action: params.action, exitCode: err.exitCode, stderr: err.stderr });
		throw new Error(`tmux ${params.action} failed: ${err.stderr || "unknown error"}`);
	}

	// Remove killed pane from sessionState
	if (params.action === "killPane" && killedPaneId) {
		handlePaneExited(params.taskId, killedPaneId).catch((err) => {
			log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
		});
	}

	log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
}

export async function tmuxPaneCount(params: { taskId: string }): Promise<{ count: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	try {
		const count = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
		return { count };
	} catch {
		return { count: 0 };
	}
}

/**
 * Kill ONE specific pane by its tmux id (`%N`) — the target the two-step close-
 * pane picker committed to. Unlike {@link tmuxAction}'s `killPane` (which kills
 * whatever tmux thinks is active), this closes exactly the hovered pane the user
 * clicked, regardless of which pane is currently focused.
 *
 * Mirrors the killPane guards: refuse to kill the last pane in the session unless
 * `force` is set (the frontend confirms first, since that tears down the agent's
 * own session), and clean up sessionState via handlePaneExited (kill-pane does
 * not fire tmux's pane-exited hook).
 */
export async function tmuxKillPane(params: { taskId: string; paneId: string; force?: boolean }): Promise<{ killed: boolean }> {
	log.info("→ tmuxKillPane", { taskId: params.taskId.slice(0, 8), paneId: params.paneId, force: params.force === true });
	// The pane id always originates from our own tmuxLayout (`%N`); validate the
	// shape defensively before it reaches a spawn arg.
	if (!/^%\d+$/.test(params.paneId)) {
		log.warn("tmuxKillPane rejected — malformed pane id", { paneId: params.paneId });
		return { killed: false };
	}

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	if (!params.force) {
		try {
			const paneCount = (await tmux.listPanes(PANE_ID_FORMAT, { target: tmuxSession, scope: "session", socket })).length;
			if (paneCount <= 1) {
				log.info("tmuxKillPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
				return { killed: false };
			}
		} catch { /* best effort — if counting fails, fall through to the normal kill */ }
	}

	try {
		await tmux.killPane(params.paneId, { socket });
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		log.error("tmuxKillPane failed", { paneId: params.paneId, exitCode: err.exitCode, stderr: err.stderr });
		throw new Error(`tmux kill-pane failed: ${err.stderr || "unknown error"}`);
	}

	// kill-pane does NOT trigger tmux's pane-exited hook, so clean up sessionState here.
	handlePaneExited(params.taskId, params.paneId).catch((err) => {
		log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
	});

	log.info("← tmuxKillPane done", { taskId: params.taskId.slice(0, 8), paneId: params.paneId });
	return { killed: true };
}

export interface PaneLayoutInfo {
	count: number;
	activeIndex: number;
	zoomed: boolean;
	paneIds: string[];
	labels: string[];
}

/**
 * Read the current window's pane layout (window-scoped, NOT `-s`): how many
 * panes, which one is active (by display order), whether the window is zoomed,
 * each pane's id, and a human label per pane. Drives the narrow-viewport pane
 * switcher. Returns an empty layout when the session is gone or tmux errors.
 *
 * Label = an explicitly-set pane title (dev3 names some panes "Agent" / "Shell"
 * / "Dev Server") — but tmux defaults pane_title to the hostname, so a title
 * equal to host_short is treated as unset — else the running command, else "".
 * The frontend localises the empty fallback to "Pane N".
 */
export async function readPaneLayout(socket: string, tmuxSession: string): Promise<PaneLayoutInfo> {
	try {
		const rows = await tmux.listPanes(PANE_SWITCHER_FORMAT, { target: tmuxSession, socket });
		const paneIds: string[] = [];
		const labels: string[] = [];
		let activeIndex = 0;
		let zoomed = false;
		rows.forEach((row, i) => {
			paneIds.push(row.paneId);
			const trimmedTitle = row.title.trim();
			const meaningfulTitle = trimmedTitle && trimmedTitle !== row.hostShort.trim() ? trimmedTitle : "";
			labels.push(meaningfulTitle || row.command.trim() || "");
			if (row.active) {
				activeIndex = i;
				zoomed = row.zoomed;
			}
		});
		return { count: rows.length, activeIndex, zoomed, paneIds, labels };
	} catch {
		return { count: 0, activeIndex: 0, zoomed: false, paneIds: [], labels: [] };
	}
}

/**
 * Pane navigation for the narrow-viewport pane carousel. In one round trip it
 * can select the next/prev/absolute pane AND enforce a zoom intent, then return
 * the fresh layout for the pager UI.
 *
 * The tmux gotcha (doctrine §6.3): `select-pane` auto-unzooms the window. So a
 * "keep zoom" step must select first, then re-zoom. We make zooming idempotent
 * (read the flag, toggle only on a mismatch) so a doubled call — React Strict
 * Mode, a retry, a poll racing a tap — never flips zoom the wrong way.
 */
export async function tmuxPaneNavigate(params: {
	taskId: string;
	step?: "next" | "prev";
	index?: number;
	paneId?: string;
	zoom?: boolean;
}): Promise<{ count: number; activeIndex: number; zoomed: boolean; labels: string[] }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	let info = await readPaneLayout(socket, tmuxSession);
	if (info.count === 0) return { count: 0, activeIndex: 0, zoomed: false, labels: [] };

	// Navigate (only meaningful with more than one pane).
	if (info.count > 1) {
		let navigated = false;
		if (params.step === "next") {
			await tmux.selectPane(`${tmuxSession}:.+`, { socket, bestEffort: true });
			navigated = true;
		} else if (params.step === "prev") {
			await tmux.selectPane(`${tmuxSession}:.-`, { socket, bestEffort: true });
			navigated = true;
		} else if (typeof params.index === "number" && info.paneIds[params.index]) {
			await tmux.selectPane(info.paneIds[params.index], { socket, bestEffort: true });
			navigated = true;
		} else if (params.paneId && info.paneIds.includes(params.paneId)) {
			// Jump-by-id (the pane-map sheet taps a specific box). Robust against
			// any index/order drift between the map's layout and this read.
			await tmux.selectPane(params.paneId, { socket, bestEffort: true });
			navigated = true;
		}
		// Re-read after a move: select-pane changes the active pane AND auto-unzooms.
		if (navigated) info = await readPaneLayout(socket, tmuxSession);
	}

	// Enforce zoom intent idempotently (single pane needs no zoom — it already fills the window).
	let zoomed = info.zoomed;
	if (info.count > 1 && typeof params.zoom === "boolean" && params.zoom !== info.zoomed) {
		await tmux.toggleZoom(tmuxSession, { socket, bestEffort: true });
		zoomed = params.zoom;
	}

	log.info("← tmuxPaneNavigate", {
		taskId: params.taskId.slice(0, 8),
		step: params.step ?? "none",
		index: params.index ?? -1,
		count: info.count,
		activeIndex: info.activeIndex,
		zoomed,
	});
	return { count: info.count, activeIndex: info.activeIndex, zoomed, labels: info.labels };
}

/**
 * Snapshot the full tmux layout (windows + every pane's geometry) for a task's
 * session. Powers the narrow-viewport "zoom-out" pane-map sheet — the same data
 * `dev3 ui state` renders as ASCII boxes. Reuses the session's own socket so it
 * also works for the rare non-default socket.
 */
async function tmuxLayout(params: { taskId: string }): Promise<TmuxLayout> {
	const socket = pty.getSessionSocket(params.taskId);
	return pty.getTmuxLayout(params.taskId, socket);
}

interface WindowLayoutInfo {
	count: number;
	activeIndex: number;
	windowIds: string[];
	labels: string[];
}

/**
 * Read a session's window layout: how many windows (separate workspaces in the
 * same tmux session), which one is active (by display order), each window's id,
 * and a human label per window. Drives the narrow-viewport WINDOW switcher (the
 * sibling of the pane switcher — window = outer workspace, pane = inner split).
 * Returns an empty layout when the session is gone or tmux errors.
 *
 * Label = the window name. Unlike pane_title (which tmux defaults to the
 * hostname), tmux auto-names a window after its running command, which is
 * already meaningful; the frontend localises an empty name to "Window N".
 */
async function readWindowLayout(socket: string, tmuxSession: string): Promise<WindowLayoutInfo> {
	try {
		const rows = await tmux.listWindows(WINDOW_SWITCHER_FORMAT, { target: tmuxSession, socket });
		const windowIds: string[] = [];
		const labels: string[] = [];
		let activeIndex = 0;
		rows.forEach((row, i) => {
			windowIds.push(row.windowId);
			labels.push(row.name.trim());
			if (row.active) activeIndex = i;
		});
		return { count: rows.length, activeIndex, windowIds, labels };
	} catch {
		return { count: 0, activeIndex: 0, windowIds: [], labels: [] };
	}
}

/**
 * Window navigation for the narrow-viewport window switcher. In one round trip
 * it selects the next/prev/absolute window and returns the fresh layout for the
 * switcher UI. There is no zoom concept for windows (each window is its own
 * workspace); the pane carousel handles the one-pane-at-a-time view inside the
 * newly-active window once the frontend re-reads it.
 */
async function tmuxWindowNavigate(params: {
	taskId: string;
	step?: "next" | "prev";
	index?: number;
}): Promise<{ count: number; activeIndex: number; labels: string[] }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	let info = await readWindowLayout(socket, tmuxSession);
	if (info.count === 0) return { count: 0, activeIndex: 0, labels: [] };

	// Navigate (only meaningful with more than one window). `:+` / `:-` are the
	// next / previous window and wrap around, mirroring the pane carousel.
	if (info.count > 1) {
		let navigated = false;
		if (params.step === "next") {
			await tmux.selectWindow(`${tmuxSession}:+`, { socket, bestEffort: true });
			navigated = true;
		} else if (params.step === "prev") {
			await tmux.selectWindow(`${tmuxSession}:-`, { socket, bestEffort: true });
			navigated = true;
		} else if (typeof params.index === "number" && info.windowIds[params.index]) {
			await tmux.selectWindow(info.windowIds[params.index], { socket, bestEffort: true });
			navigated = true;
		}
		if (navigated) info = await readWindowLayout(socket, tmuxSession);
	}

	log.info("← tmuxWindowNavigate", {
		taskId: params.taskId.slice(0, 8),
		step: params.step ?? "none",
		index: params.index ?? -1,
		count: info.count,
		activeIndex: info.activeIndex,
	});
	return { count: info.count, activeIndex: info.activeIndex, labels: info.labels };
}

/**
 * iTerm2-style Alt/Option-click: walk the shell cursor to the clicked cell.
 *
 * The renderer cannot gate this on `hasMouseTracking()` — dev3's tmux runs
 * with `mouse on`, which keeps the OUTER terminal's mouse tracking enabled
 * for the whole session, plain shell or not (decision 098). So the renderer
 * forwards the clicked cell here, and tmux is asked what actually runs in
 * that pane: only plain shells (zsh/bash/fish/…) get arrow keys; TUIs that
 * own the mouse (Claude Code, vim, htop) are left untouched — the alt-click
 * SGR event reaches them via the normal mouse pass-through instead.
 *
 * col/row are 1-based cells of the outer terminal grid. All decision logic
 * is pure and unit-tested in ../tmux-alt-click.ts.
 */
async function tmuxAltClickMoveCursor(params: { taskId: string; col: number; row: number }): Promise<{ moved: boolean }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	const x0 = Math.floor(params.col) - 1;
	const y0 = Math.floor(params.row) - 1;
	if (x0 < 0 || y0 < 0) return { moved: false };

	// Panes of the session's CURRENT window only (that's what the client shows).
	let panes;
	try {
		panes = validAltClickPanes(await tmux.listPanes(ALT_CLICK_PANE_FORMAT, { target: tmuxSession, socket }));
	} catch {
		return { moved: false };
	}

	const pane = findAltClickPane(panes, x0, y0);
	if (!pane) return { moved: false };

	const reason = altClickIneligibleReason(pane);
	if (reason) {
		log.debug("tmuxAltClickMoveCursor skipped", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, reason });
		return { moved: false };
	}

	// Row text of the cursor line — clamps the target to end-of-input so a
	// click in the blank area right of the text lands exactly at EOL.
	let rowText = "";
	try {
		const capOut = await tmux.capturePane({
			target: pane.paneId,
			startLine: pane.cursorY,
			endLine: pane.cursorY,
			socket,
		});
		rowText = capOut.replace(/\n$/, "");
	} catch {
		// Capture failed — fall back to an empty row (clamps to column 0).
	}

	const plan = computeAltClickKeys(pane, x0, y0, rowText);
	if (!plan) return { moved: false };

	// Focus the clicked pane (alt-clicks bypass tmux's own MouseDown1Pane
	// select-pane binding). Skip when already active — select-pane would
	// needlessly unzoom a zoomed window (see tmuxPaneNavigate gotcha).
	if (!pane.active) {
		await tmux.selectPane(pane.paneId, { socket, bestEffort: true });
	}
	await tmux.sendKeys(pane.paneId, Array<string>(plan.count).fill(plan.key), { socket, bestEffort: true });
	log.info("← tmuxAltClickMoveCursor", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, key: plan.key, count: plan.count });
	return { moved: true };
}

/**
 * Every tmux session whose panes a terminal key owns: the session itself, plus
 * the task's detached dev-server sibling (the window users most often scroll).
 * Registry-aware, so a quick shell resolves to its own `dev3-pt-<id>` instead of
 * a task name that cannot exist — asking `tmuxSessionExists` here reported "no
 * session" for every quick shell and made copy-mode invisible there.
 */
async function copyModeSessions(key: string, socket: string): Promise<string[]> {
	const found: string[] = [];
	const own = pty.getSessionTmuxName(key);
	if (await tmux.hasSession(own, { socket })) found.push(own);
	if (pty.isProjectSessionKey(key)) return found;
	const devSession = devServerSessionName(key);
	if (await tmux.hasSession(devSession, { socket })) found.push(devSession);
	return found;
}

async function exitCopyModeInSession(socket: string, tmuxSession: string): Promise<number> {
	let panesInMode: string[];
	try {
		const rows = await tmux.listPanes(PANE_IN_MODE_FORMAT, { target: tmuxSession, scope: "session", socket });
		panesInMode = rows.filter((row) => row.paneId && row.inMode).map((row) => row.paneId);
	} catch (err) {
		if (err instanceof TmuxError) return 0;
		throw err;
	}

	for (const paneId of panesInMode) {
		await tmux.exitCopyMode(paneId, { socket, bestEffort: true });
	}

	return panesInMode.length;
}

/**
 * Is any pane of the task's tmux session still in copy-mode? The touch
 * scroll-to-latest button polls this while it believes the pane is scrolled
 * into history: tmux leaves copy-mode on its own when a swipe reaches the
 * bottom, and the renderer has no other way to notice.
 */
async function tmuxPanesInMode(params: { taskId: string }): Promise<{ inMode: boolean }> {
	const socket = pty.getSessionSocket(params.taskId);
	for (const session of await copyModeSessions(params.taskId, socket)) {
		try {
			const rows = await tmux.listPanes(PANE_IN_MODE_FORMAT, { target: session, scope: "session", socket });
			if (rows.some((row) => row.paneId && row.inMode)) return { inMode: true };
		} catch (err) {
			if (!(err instanceof TmuxError)) throw err;
		}
	}
	return { inMode: false };
}

async function exitCopyModeAllPanes(params: { taskId: string }): Promise<{ panesExited: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	// Copy mode is a tmux concept, so a native task owns no session here and this
	// whole handler is a no-op for it.
	const sessions = await copyModeSessions(params.taskId, socket);

	let total = 0;
	for (const session of sessions) {
		total += await exitCopyModeInSession(socket, session);
	}

	if (total > 0) {
		log.info("Exited copy-mode in panes", { taskId: params.taskId.slice(0, 8), count: total, sessions });
	}
	return { panesExited: total };
}

// ── Terminal ⌘F search (tmux copy-mode search) ─────────────────────────
//
// The scrollback lives inside tmux (mouse-mode on → wheel scroll is SGR mouse,
// ghostty's own buffer only holds the visible screen), so search runs in tmux
// copy-mode: tmux highlights every match in the pane content and the picture
// streams back through the PTY for free. See decision 141.

const SEARCH_PANE_ID_RE = /^%\d+$/;

async function searchMatchCount(paneId: string, socket: string): Promise<number> {
	const state = await tmux.displayMessage(SEARCH_STATE_FORMAT, { target: paneId, socket });
	// search_count is stale after a miss — search_present gates it (see formats.ts).
	return state?.present ? state.count : 0;
}

/**
 * Set (or clear) the search query in one pane. The first call resolves the
 * session's active pane and returns its id; later calls pass that id back so
 * the search stays pinned to one pane even if tmux focus moves. Every query
 * re-anchors at history-bottom — plain `search-backward` searches up from the
 * CURRENT cursor, so incremental typing would otherwise drift the match
 * further up with each keystroke (verified live, decision 141).
 * Returns `paneId: null` when the target pane is gone — the caller should
 * re-resolve on the next update.
 */
async function tmuxSearchUpdate(params: { taskId: string; query: string; paneId?: string }): Promise<{ paneId: string | null; matches: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);

	if (params.paneId !== undefined && !SEARCH_PANE_ID_RE.test(params.paneId)) {
		log.warn("tmuxSearchUpdate rejected — malformed pane id", { paneId: params.paneId });
		return { paneId: null, matches: 0 };
	}

	let paneId = params.paneId ?? null;
	try {
		if (!paneId) paneId = await tmux.activePaneId(tmuxSession, { socket });
		if (!paneId) return { paneId: null, matches: 0 };

		if (!params.query) {
			// Cleared query — drop the highlight and unfreeze the pane.
			await tmux.exitCopyMode(paneId, { socket, bestEffort: true });
			return { paneId, matches: 0 };
		}

		await tmux.enterCopyMode(paneId, { socket });
		await tmux.copyModeHistoryBottom(paneId, { socket });
		await tmux.copyModeSearchBackwardText(paneId, params.query, { socket });
		return { paneId, matches: await searchMatchCount(paneId, socket) };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		// Pane died mid-search — tell the frontend to re-resolve.
		log.info("tmuxSearchUpdate target gone", { taskId: params.taskId.slice(0, 8), paneId, stderr: err.stderr });
		return { paneId: null, matches: 0 };
	}
}

/** Step to the next match: "older" walks up the history, "newer" back down. */
async function tmuxSearchStep(params: { taskId: string; paneId: string; direction: "older" | "newer" }): Promise<{ matches: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	if (!SEARCH_PANE_ID_RE.test(params.paneId)) return { matches: 0 };
	try {
		await tmux.copyModeSearchStep(params.paneId, params.direction, { socket });
		return { matches: await searchMatchCount(params.paneId, socket) };
	} catch (err) {
		if (!(err instanceof TmuxError)) throw err;
		return { matches: 0 };
	}
}

/** Close the search: leave copy-mode so the pane resumes live output. */
async function tmuxSearchCancel(params: { taskId: string; paneId: string }): Promise<void> {
	const socket = pty.getSessionSocket(params.taskId);
	if (!SEARCH_PANE_ID_RE.test(params.paneId)) return;
	await tmux.exitCopyMode(params.paneId, { socket, bestEffort: true });
}

async function spawnAgentInTask(params: {
	taskId: string;
	projectId: string;
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
	/** Hand the new agent a retelling of this task's newest conversation. */
	handoff?: boolean;
}): Promise<SpawnAgentResult> {
	log.info("→ spawnAgentInTask", { taskId: params.taskId.slice(0, 8), agentId: params.agentId, configId: params.configId, handoff: params.handoff === true });

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn agent");
	}

	// Written BEFORE the split on purpose: a conversation that cannot be retold
	// must fail with no pane opened, rather than leave a bare agent standing where
	// the user asked for a takeover.
	const handoff = params.handoff ? await prepareTaskHandoff(task) : null;
	if (params.handoff && !handoff) {
		throw new Error("Nothing to hand over: no parseable agent transcript has been written for this task yet.");
	}

	// The pointer rides the new agent's own command line, the way a task's first
	// launch carries its description. It used to be typed into the pane afterwards
	// and held until the pane went quiet — but the hold is deferred by ANY human
	// keystroke in the task, and the user is invariably still typing in the pane he
	// spawned this from, so the pointer sat there until he pressed Enter (seq 1775).
	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: handoff ? handoffPrompt(handoff) : "",
		projectName: project.name,
		projectPath: project.path,
		worktreePath: task.worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedAgentFamily: AgentFamily | undefined;
	let resolvedLaunchModel: string | undefined;
	let launchedAgentId = params.agentId;
	let launchedConfigId = params.configId;

	// Pre-assign a session ID for Claude so we can recover this pane later
	const freshSessionId = crypto.randomUUID();
	// Per-launch account for THIS extra pane (independent of the main pane's).
	const cmdOptions: agents.CommandOptions = { sessionId: freshSessionId, accountId: params.accountId };

	if (params.agentId) {
		const resolved = await agents.resolveCommandForAgent(params.agentId, params.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		resolvedLaunchModel = resolved.launchModel;
		launchedAgentId = resolved.agent?.id ?? params.agentId;
		launchedConfigId = resolved.config?.id ?? params.configId;
	} else {
		const resolved = await agents.resolveCommandForProject(
			project,
			task.title,
			// A takeover replaces the brief: the retelling already carries the original
			// request, so re-launching on the raw description would start the work twice.
			handoff ? ctx.taskDescription : task.description,
			task.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		resolvedLaunchModel = resolved.launchModel;
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Register trust / re-patch the agent's config before spawning. The primary
	// task launch does this; without it a spawned Codex pane runs against a stale
	// config.toml and crashes on the legacy-profile check (see ensureAgentTrust).
	await ensureAgentTrust(task.worktreePath, project.path, resolvedBaseCmd, params.accountId, task.foreignCode, resolvedAgentFamily);
	tmuxCmd = await applyAgentHooksToCommand(task.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		family: resolvedAgentFamily,
	});
	tmuxCmd = await applyModelVersionNotice(task.id, tmuxCmd, {
		baseCmd: resolvedBaseCmd,
		family: resolvedAgentFamily,
		launchModel: resolvedLaunchModel,
	});

	const env: Record<string, string> = {
		...AGENT_ENV_DEFAULTS,
		...(await repoConfig.resolveProjectEnv(project, task.worktreePath, { foreignCode: task.foreignCode })),
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, task.worktreePath),
	};

	const existingPorts = portPool.getPortAssignments(task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = dev3TaskTempPath(task.id, generatedScriptName(`spawn-${Date.now()}`));
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env));

	const socket = pty.getSessionSocket(params.taskId);

	// One extra pane in the task's own terminal, on whichever backend it runs. The
	// tmux split is the same one this path always did (right half, no -l); the
	// native path opens a real coordinator pane and never touches tmux.
	//
	// The bare primitive, NOT an auxiliary purpose: "+ Agent" is the user asking for
	// one more agent beside whatever is already there, so several of these panes
	// coexist by design, while a purpose owns at most one pane and replaces it.
	let handle: AuxPaneHandle;
	try {
		handle = await splitTaskPane({
			task,
			placement: "right",
			size: "",
			cwd: task.worktreePath,
			env: { DEV3_TASK_ID: task.id, DEV3_WORKTREE_ROOT: task.worktreePath },
			socket,
			tmuxCommand: `bash "${scriptPath}"`,
			nativeLaunch: generatedScriptLaunch(scriptPath),
		});
	} catch (err) {
		log.error("spawnAgentInTask failed", { taskId: params.taskId.slice(0, 8), error: String(err) });
		throw new Error(
			err instanceof AuxPaneUnavailableError
				? "Failed to spawn agent: the task terminal is not running, so there is no pane to split — start the task first."
				: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const newPaneId = handle.paneId || null;
	if (handle.backend === "tmux" && newPaneId) void markAgentPane(socket, newPaneId);

	// sessionState.panes is the tmux pane registry — recovery and `handlePaneExited`
	// reconcile it against live tmux panes. A native pane is owned by the coordinator
	// record instead, so writing it here would leave a phantom entry forever.
	const paneEntry = {
		paneId: newPaneId,
		agentCmd: resolvedBaseCmd,
		sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null,
		agentId: launchedAgentId,
		configId: launchedConfigId,
		accountId: params.accountId,
		agentFamily: resolvedAgentFamily,
	};
	const existingPanes = task.sessionState?.panes ?? [];
	try {
		const updated = await data.updateTask(project, task.id, {
			agentId: launchedAgentId,
			configId: launchedConfigId,
			...(handle.backend === "tmux" ? { sessionState: { panes: [...existingPanes, paneEntry] } } : {}),
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("Recorded the spawned agent", {
			taskId: params.taskId.slice(0, 8),
			backend: handle.backend,
			paneCount: handle.backend === "tmux" ? existingPanes.length + 1 : existingPanes.length,
		});
	} catch (err) {
		log.error("Failed to append pane to sessionState (non-fatal)", { error: String(err) });
	}

	// Bump the favorite usage counter if this launched combo is starred (best-effort).
	void recordFavoriteUsages([{ agentId: launchedAgentId, configId: launchedConfigId }]);

	let handoffResult: SpawnAgentResult["handoff"] = null;
	if (handoff) {
		// Nothing is typed and nothing waits: the pointer went in as the launch
		// prompt above, so it is the agent's first turn the moment it boots. Typing
		// into the pane is what could not be timed — the launch cannot miss.
		const delivery: AgentPromptDelivery = { status: "delivered", reason: "launch-prompt" };
		handoffResult = { path: handoff.path, chars: handoff.chars, source: handoff.source, delivery };
		log.info("Handed the conversation to the spawned agent", {
			taskId: params.taskId.slice(0, 8),
			chars: handoff.chars,
			delivery: delivery.status,
		});
	}

	log.info("← spawnAgentInTask done", { taskId: params.taskId.slice(0, 8) });
	return { handoff: handoffResult };
}

/**
 * What a handoff from this task would retell. Answered from the transcripts on
 * disk, so a task whose agent never wrote one gets a plain null and the picker
 * offers nothing rather than an option that would fail on click.
 */
async function previewTaskHandoffHandler(params: { taskId: string; projectId: string }): Promise<HandoffPreview | null> {
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	return previewTaskHandoff(task);
}

/** How long the hunter agents get to boot before their prompt is typed in. */
const BUG_HUNTER_AUTOTYPE_DELAY_MS = 5000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve the comparison ref for bug-hunter scoping, mirroring the renderer's
// getDefaultTaskCompareRef (src/mainview/components/task-info-panel/useTaskBranchStatus.ts)
// so the lightbox path honors the project's configured compare ref instead of
// always assuming origin/<base>.
export async function resolveBugHunterCompareRef(task: Task, project: Project): Promise<string> {
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const taskBaseBranch = task.baseBranch || projectBaseBranch;
	// Task forked from a non-default base → compare against that local branch.
	if (taskBaseBranch !== projectBaseBranch) return taskBaseBranch;
	if (project.defaultCompareRef) return project.defaultCompareRef;
	if (project.defaultCompareRefMode === "local") return taskBaseBranch;
	// Nothing configured: ask git rather than assume a remote, which would send the
	// hunters at `git merge-base origin/<base> HEAD` in a repo that has no origin.
	return git.resolveCompareRef(project.path, taskBaseBranch);
}

export async function buildBugHunterPrompt(task: Task, project: Project, baseCmd = "", family?: AgentFamily): Promise<string> {
	const ref = await resolveBugHunterCompareRef(task, project);
	const branch = task.branchName || "HEAD";
	const prefix = agents.skillInvocationPrefix(baseCmd, family);
	return (
		`${prefix}dev3-bug-hunter ` +
		`You are a read-only helper inside a task owned by the main agent. ` +
		`Do NOT run the dev3 session-start checklist, rename the branch, or change this task's title, description, overview, labels, priority, status, assigned agent, or configuration. ` +
		`The only permitted dev3 write is \`dev3 note add\` for confirmed findings as instructed below; the main agent owns every other task mutation and lifecycle transition. ` +
		`Scope is locked to THIS branch only — only the changes this branch introduced, never commits pulled in from origin. ` +
		`First pin the fork point, then list only this branch's own changed files: ` +
		`run \`BASE=$(git merge-base ${ref} HEAD); git diff --name-only "$BASE" HEAD\`. ` +
		`Use that merge-base two-dot form — do NOT diff against ${ref} directly, because if this branch is not rebased that pulls in unrelated files changed only on ${ref}. ` +
		`Hunt for bugs ONLY in those changed files and the code paths they touch. ` +
		`Do NOT inspect files changed only on ${ref}, and do NOT inspect unrelated parts of the codebase. ` +
		`Branch: ${branch}. Base: ${ref}. ` +
		// In-task hunters run in their own pane, so their stdout report never reaches
		// the main agent — route findings into `[bug-hunt]` dev3 notes instead. Injected
		// only here; standalone skill invocation keeps its stdout report.
		`You are running inside a dev3 task, so your on-screen report will NOT reach the main agent — record it as dev3 notes instead. ` +
		`After presenting your normal report, add EACH confirmed critical/high/medium finding as its own dev3 note (one note per finding) via ` +
		`\`dev3 note add "..."\`, starting every note body with the literal marker "[bug-hunt]" followed by the severity, the "path:lines" location, a short title, the failure mode, and a repro hint. ` +
		`The "[bug-hunt]" marker is mandatory so the main agent can find them. ` +
		`Do NOT ask whether to create dev3 tasks and do NOT create any — recording the notes replaces the Next step offer. ` +
		`Finish with one line: the count of findings recorded and the instruction for the main agent to run \`dev3 note list\` then \`dev3 note show <id>\` and fix each.`
	);
}

async function spawnSingleBugHunterPane(opts: {
	project: Project;
	task: Task;
	socket: string;
	tmuxSession: string;
	worktreePath: string;
	agentId: string | null;
	configId: string | null;
	accountId?: string | null;
	split: { placement: AuxPanePlacement; size: string; tmuxTarget: string; nativeAnchor?: string };
}): Promise<{ handle: AuxPaneHandle; baseCmd: string; agentFamily: AgentFamily | undefined }> {
	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: "",
		projectName: opts.project.name,
		projectPath: opts.project.path,
		worktreePath: opts.worktreePath,
	};

	const freshSessionId = crypto.randomUUID();
	const cmdOptions: agents.CommandOptions = { sessionId: freshSessionId, accountId: opts.accountId };

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedAgentFamily: AgentFamily | undefined;
	let launchedAgentId = opts.agentId;
	let launchedConfigId = opts.configId;
	if (opts.agentId) {
		const resolved = await agents.resolveCommandForAgent(opts.agentId, opts.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		launchedAgentId = resolved.agent?.id ?? opts.agentId;
		launchedConfigId = resolved.config?.id ?? opts.configId;
	} else {
		const resolved = await agents.resolveCommandForProject(
			opts.project,
			opts.task.title,
			opts.task.description,
			opts.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedAgentFamily = resolved.agentFamily;
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Same trust/config-ensure the primary launch does — a Codex bug-hunter pane
	// otherwise launches against a stale config.toml and crashes.
	await ensureAgentTrust(opts.worktreePath, opts.project.path, resolvedBaseCmd, opts.accountId, opts.task.foreignCode, resolvedAgentFamily);
	tmuxCmd = await applyAgentHooksToCommand(opts.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: opts.project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		family: resolvedAgentFamily,
	});

	const env: Record<string, string> = {
		...AGENT_ENV_DEFAULTS,
		...(await repoConfig.resolveProjectEnv(opts.project, opts.worktreePath, { foreignCode: opts.task.foreignCode })),
		...buildAgentEnv(extraEnv, opts.task.id),
		...ensureArtifactTemplateEnv(opts.project, opts.task, opts.worktreePath),
	};
	const existingPorts = portPool.getPortAssignments(opts.task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = dev3TaskTempPath(
		opts.task.id,
		generatedScriptName(`bughunt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
	);
	await writeLaunchScript(scriptPath, buildCmdScript(tmuxCmd, env));

	const handle = await splitTaskPane({
		task: opts.task,
		placement: opts.split.placement,
		size: opts.split.size,
		cwd: opts.worktreePath,
		socket: opts.socket,
		tmuxTarget: opts.split.tmuxTarget,
		nativeAnchor: opts.split.nativeAnchor,
		tmuxCommand: `bash "${scriptPath}"`,
		nativeLaunch: generatedScriptLaunch(scriptPath),
	});

	// sessionState.panes is the tmux pane registry — recovery and `handlePaneExited`
	// reconcile it against live tmux panes. A native pane is owned by the
	// coordinator record instead, so writing it here would leave a permanent
	// phantom entry that no tmux pane can ever match.
	if (handle.backend === "tmux") {
		const paneEntry = {
			paneId: handle.paneId,
			agentCmd: resolvedBaseCmd,
			sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd, resolvedAgentFamily) ? freshSessionId : null,
			agentId: launchedAgentId,
			configId: launchedConfigId,
			accountId: opts.accountId,
			agentFamily: resolvedAgentFamily,
		};
		try {
			const freshTask = await data.getTask(opts.project, opts.task.id);
			const existingPanes = freshTask.sessionState?.panes ?? [];
			const updated = await data.updateTask(opts.project, opts.task.id, {
				sessionState: { panes: [...existingPanes, paneEntry] },
			});
			getPushMessage()?.("taskUpdated", { projectId: opts.project.id, task: updated });
		} catch (err) {
			log.error("Failed to append bug hunter pane to sessionState (non-fatal)", { error: String(err) });
		}
	}

	return { handle, baseCmd: resolvedBaseCmd, agentFamily: resolvedAgentFamily };
}

/**
 * The ratio each split of a hunter column needs so the panes end up equal.
 *
 * The splits form a right-nested chain: the first one holds hunter 1 against
 * everything below it, the next holds hunter 2 against what is left, and so on.
 * So split `i` (0-based) must give its first child `1 / (count - i)` of what it
 * received. For 3 hunters → 1/3 then 1/2; for 6 → 1/6, 1/5, 1/4, 1/3, 1/2.
 */
export function nativeHunterColumnRatios(count: number): number[] {
	return Array.from({ length: Math.max(0, count - 1) }, (_, i) => 1 / (count - i));
}

/**
 * Even out the hunter column of a native task, touching only the splits this
 * launch created. `anchors[i]` is the pane that was split to open hunter `i + 2`,
 * which is how each split is re-found without remembering generated split ids.
 *
 * Throws rather than settling for whatever geometry it found: a column reported
 * as launched but drawn 50/25/25 is a silently wrong result, and the caller can
 * still undo the whole launch at this point.
 */
async function equalizeNativeHunterColumn(taskId: string, anchors: string[]): Promise<void> {
	const tree = await nativeTaskPaneLayout(taskId);
	if (!tree) throw new Error("the task's native pane layout could not be read back");
	const ratios = nativeHunterColumnRatios(anchors.length + 1);
	let equalized = tree;
	anchors.forEach((anchor, i) => {
		const split = splitCreatedBySplitting(equalized, anchor);
		if (!split) throw new Error(`the split opened off ${anchor} is no longer in the layout`);
		equalized = setSplitRatio(equalized, split.id, ratios[i]);
	});
	await setNativeTaskPaneLayout(taskId, equalized);
}

/**
 * Undo a hunter launch that went wrong, on whichever backend it ran, and build the
 * error the user sees. `headline` says what actually failed; this adds what the
 * cleanup achieved.
 *
 * A close that fails is NAMED — claiming the launch was rolled back while panes
 * are still on screen is the one outcome this must never produce.
 */
async function rollBackHunterLaunch(
	task: Task,
	handles: AuxPaneHandle[],
	socket: string,
	focusedBefore: string | null,
	headline: string,
): Promise<Error> {
	const stuck: string[] = [];
	for (const handle of handles) {
		try {
			await closeTaskPane(task, handle, socket);
		} catch (err) {
			stuck.push(handle.paneId);
			log.error("Rolling back a bug hunter pane failed — it is still open", {
				taskId: task.id.slice(0, 8),
				paneId: handle.paneId,
				error: String(err),
			});
			continue;
		}
		// kill-pane does not fire tmux's pane-exited hook, so the pane this launch
		// appended to sessionState has to be retired here or it outlives the rollback.
		if (handle.backend === "tmux") {
			await handlePaneExited(task.id, handle.paneId).catch((err) =>
				log.warn("Could not retire a rolled-back hunter pane from sessionState", { paneId: handle.paneId, error: String(err) }),
			);
		}
	}
	if (focusedBefore) await focusNativeTaskPane(task.id, focusedBefore).catch(() => {});

	if (stuck.length > 0) {
		return new Error(
			`${headline}; the rollback could not close ${stuck.join(", ")} — ` +
				`${stuck.length === 1 ? "that pane is" : "those panes are"} still open, close ${stuck.length === 1 ? "it" : "them"} by hand.`,
		);
	}
	return new Error(`${headline}; launch rolled back.`);
}

/**
 * One hunter's prompt, as a verdict rather than an exception. A throw carries no
 * verdict — nothing can then say whether the text landed — so it becomes
 * `unconfirmed` and keeps the pane, instead of joining the proven failures that
 * undo the launch.
 */
async function deliverHunterPrompt(task: Task, paneId: string, prompt: string): Promise<AgentPromptDelivery> {
	try {
		return await deliverAgentPrompt(task, prompt, { kind: "pane", paneId });
	} catch (err) {
		return { status: "unconfirmed", reason: "backend-failure", detail: String(err) };
	}
}

async function spawnBugHuntersInTask(params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; count: number; accountId?: string | null }): Promise<{ spawned: number }> {
	log.info("→ spawnBugHuntersInTask", { taskId: params.taskId.slice(0, 8), count: params.count, agentId: params.agentId });

	const requestedCount = Math.max(1, Math.min(6, Math.floor(params.count)));

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn bug hunters");
	}

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = taskSessionName(params.taskId);
	const native = taskTerminalBackendIdentity(task) === "native";

	// The pane that had focus before the hunters landed — the agent's own. Read
	// before the first split, because splitting makes the NEW pane active.
	const focusedBefore = native ? (await nativeTaskPanesState(params.taskId))?.activePaneId || null : null;

	const handles: AuxPaneHandle[] = [];

	// First hunter: split the task terminal horizontally, taking the right 50%.
	const first = await spawnSingleBugHunterPane({
		project,
		task,
		socket,
		tmuxSession,
		worktreePath: task.worktreePath,
		agentId: params.agentId,
		configId: params.configId,
		accountId: params.accountId,
		split: { placement: "right", size: "50%", tmuxTarget: tmuxSession, nativeAnchor: focusedBefore ?? undefined },
	});
	if (first.handle.paneId) handles.push(first.handle);
	const resolvedBaseCmd = first.baseCmd;
	const resolvedHunterFamily = first.agentFamily;

	// Subsequent hunters: split the right column vertically off the previous
	// hunter's pane. tmux needs an explicit -p per split so the whole right column
	// ends up equal-sized WITHOUT calling select-layout on the window (that command
	// would also shrink the main left pane to 1/N of the window, which broke the
	// layout in the first iteration). Formula: at split i (1-indexed, 1..N-1), the
	// new pane takes (N-i)/(N-i+1) of the target's current size. For N=3 → 67, 50.
	// For N=6 → 83, 80, 75, 67, 50. The native SplitTree ignores the size and always
	// halves, which is why the native path re-publishes the column ratios below.
	const nativeAnchors: string[] = [];
	for (let i = 1; i < requestedCount; i++) {
		const previous = handles[handles.length - 1] ?? first.handle;
		if (!previous.paneId) break;
		const remaining = requestedCount - i;
		const percent = Math.round((remaining / (remaining + 1)) * 100);
		try {
			const { handle } = await spawnSingleBugHunterPane({
				project,
				task,
				socket,
				tmuxSession,
				worktreePath: task.worktreePath,
				agentId: params.agentId,
				configId: params.configId,
				accountId: params.accountId,
				split: { placement: "below", size: `${percent}%`, tmuxTarget: previous.paneId, nativeAnchor: previous.paneId },
			});
			if (handle.paneId) {
				nativeAnchors.push(previous.paneId);
				handles.push(handle);
			}
		} catch (err) {
			if (!native) {
				// tmux: a failed split leaves nothing behind, and the panes that did
				// open are usable — keep going, exactly as this path always has.
				log.warn("Bug hunter split failed (continuing with remaining)", { index: i, error: String(err) });
				continue;
			}
			// Native: a half-filled pane set is worse than none — the user asked for N
			// hunters, got fewer, and nothing on screen says so. Undo and report.
			log.error("Native bug hunter split failed — rolling back the panes already opened", {
				taskId: params.taskId.slice(0, 8),
				opened: handles.length,
				error: String(err),
			});
			throw await rollBackHunterLaunch(
				task,
				handles,
				socket,
				focusedBefore,
				`Only ${handles.length} of ${requestedCount} bug hunters could be started (${String(err)})`,
			);
		}
	}

	// Native only: the SplitTree halves whatever it splits, so the chain above lands
	// at 50/25/25 instead of the equal thirds the tmux path produces. Re-publish the
	// ratios of exactly the splits this launch created — the agent's own pane and
	// anything that was open before keep their geometry untouched.
	if (native && nativeAnchors.length > 0) {
		try {
			await equalizeNativeHunterColumn(params.taskId, nativeAnchors);
		} catch (err) {
			log.error("Could not even out the native bug hunter column — rolling the launch back", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
			});
			throw await rollBackHunterLaunch(
				task,
				handles,
				socket,
				focusedBefore,
				`All ${handles.length} hunter panes opened, but the column could not be laid out evenly (${String(err)})`,
			);
		}
	}

	// After the agents have had time to boot, paste the branch-scoped bug-hunter
	// slash command into each pane. The scope clause is mandatory: hunters must
	// only inspect files changed in this branch, never the whole codebase.
	const prompt = await buildBugHunterPrompt(task, project, resolvedBaseCmd, resolvedHunterFamily);

	// The agent keeps the keyboard: a hunter pane became active on every split, and
	// the main agent must not lose input just because hunters started.
	if (focusedBefore) {
		await focusNativeTaskPane(params.taskId, focusedBefore).catch((err) =>
			log.warn("Could not restore focus to the agent pane after launching bug hunters", {
				taskId: params.taskId.slice(0, 8),
				error: String(err),
			}),
		);
	}

	// The prompt decides the launch on BOTH backends. Delivery runs through the guarded
	// seam (`201-backend-neutral-pane-input`): the pane is pinned to one backend generation, and the answer
	// is one of three — landed, cannot say, or provably nothing sent. Only the last one
	// undoes the launch, because a hunter that never got its prompt is a pane the user
	// has to notice and close by hand, while a pane that may have got it must not be
	// killed on a guess.
	await sleep(BUG_HUNTER_AUTOTYPE_DELAY_MS);
	const undelivered: string[] = [];
	for (const handle of handles) {
		const delivery = await deliverHunterPrompt(task, handle.paneId, prompt);
		if (!agentPromptMayHaveLanded(delivery)) {
			undelivered.push(`${handle.paneId} (${delivery.reason ?? "no reason given"})`);
			continue;
		}
		if (delivery.status === "unconfirmed") {
			log.warn("Bug hunter prompt could not be confirmed — keeping the pane", {
				taskId: params.taskId.slice(0, 8),
				paneId: handle.paneId,
				reason: delivery.reason,
				detail: delivery.detail,
			});
		}
	}
	if (undelivered.length > 0) {
		log.error("Bug hunter prompt was not delivered — rolling the launch back", {
			taskId: params.taskId.slice(0, 8),
			native,
			undelivered,
		});
		throw await rollBackHunterLaunch(
			task,
			handles,
			socket,
			focusedBefore,
			`All ${handles.length} hunter ${handles.length === 1 ? "pane" : "panes"} opened, ` +
				`but the hunt prompt never reached ${undelivered.join(", ")}`,
		);
	}

	// Bump favorite usage — one per hunter actually spawned (all share the combo). Best-effort.
	void recordFavoriteUsages(
		Array.from({ length: handles.length }, () => ({ agentId: params.agentId, configId: params.configId })),
	);

	log.info("← spawnBugHuntersInTask done", { taskId: params.taskId.slice(0, 8), spawned: handles.length, native });
	return { spawned: handles.length };
}

/**
 * Called when a tmux pane exits. Reconciles sessionState against live panes
 * rather than matching by exact paneId — this handles setup panes, unmanaged
 * panes, and entries that never got a paneId assigned.
 *
 * Algorithm:
 * 1. Remove entries whose paneId is set and not in the live pane set.
 * 2. If exactly one entry has paneId=null and exactly one live pane is
 *    unmatched, assign it (the setup pane exited, leaving the real agent).
 * 3. If no live panes remain and null-paneId entries exist, remove them too.
 */
export async function handlePaneExited(taskId: string, _exitedPaneId: string): Promise<void> {
	try {
		const { task, project } = await findTaskAcrossProjects(taskId);
		if (!task || !project) return;
		const panes = task.sessionState?.panes ?? [];
		if (!panes.length) return;

		const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
		const livePaneIds = new Set(await pty.listPaneIds(taskId, socket));

		// Step 1: remove entries with a known paneId that is no longer alive
		let surviving = panes.filter(p => !p.paneId || livePaneIds.has(p.paneId));

		// Step 2: try to assign paneId to null entries via 1:1 matching
		const matchedIds = new Set(surviving.filter(p => p.paneId).map(p => p.paneId!));
		const unmatchedLive = [...livePaneIds].filter(id => !matchedIds.has(id));
		const nullEntries = surviving.filter(p => !p.paneId);

		if (nullEntries.length === 1 && unmatchedLive.length === 1) {
			// High confidence: the one unmatched live pane is the one null entry's agent
			nullEntries[0] = { ...nullEntries[0], paneId: unmatchedLive[0] };
			surviving = surviving.map(p => !p.paneId ? nullEntries[0] : p);
			log.info("Reconciled paneId for unmatched entry", { taskId: taskId.slice(0, 8), paneId: unmatchedLive[0] });
		} else if (unmatchedLive.length === 0 && nullEntries.length > 0) {
			// No live panes left to match — these agents are dead
			surviving = surviving.filter(p => !!p.paneId);
		}

		if (surviving.length !== panes.length || surviving.some((p, i) => p.paneId !== panes[i].paneId)) {
			await data.updateTask(project, task.id, { sessionState: { panes: surviving } });
			log.info("Reconciled sessionState after pane exit", {
				taskId: taskId.slice(0, 8),
				before: panes.length,
				after: surviving.length,
				livePanes: [...livePaneIds],
			});
		}
	} catch (err) {
		log.warn("handlePaneExited failed (non-fatal)", { taskId: taskId.slice(0, 8), error: String(err) });
	}
}

/**
 * What the PTY server read versus what it managed to send, per live session.
 *
 * Read by the Debug → Terminal Performance overlay, which otherwise only sees
 * what the renderer already processed and so cannot tell a quiet shell from a
 * backlog. See `pty-throughput.ts`.
 */
function terminalPtyStats(): { sessions: Record<string, PtyThroughputStats> } {
	return { sessions: throughputSnapshot() };
}

export const tmuxPtyHandlers = {
	terminalPtyStats,
	runDevServer,
	checkDevServer,
	stopDevServer,
	restartDevServer,
	getDevServerStatus,
	openFileBrowser,
	getTerminalPreview,
	checkWorktreeExists,
	getPtyUrl,
	getProjectPtyUrl,
	destroyProjectTerminal,
	getTaskPorts,
	getPortAllocations,
	listTmuxSessions,
	setResourceMonitorBoost,
	killTmuxSession,
	tmuxLayout,
	tmuxWindowNavigate,
	tmuxAltClickMoveCursor,
	exitCopyModeAllPanes,
	tmuxPanesInMode,
	tmuxSearchUpdate,
	tmuxSearchStep,
	tmuxSearchCancel,
	spawnAgentInTask,
	previewTaskHandoff: previewTaskHandoffHandler,
	spawnBugHuntersInTask,
	resumeTask,
	restartTask,
	rerunSetupScript,
	dismissSetupFailure,
	dismissCloneFailures,
};
