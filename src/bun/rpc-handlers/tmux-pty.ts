import { existsSync, realpathSync } from "node:fs";
import type { ColumnAgentConfig, DevServerStatus, PermissionMode, PortInfo, Project, Task, TmuxLayout, TmuxSessionInfo } from "../../shared/types";
import { getTaskTitle } from "../../shared/types";
import * as data from "../data";
import * as pty from "../pty-server";
import * as agents from "../agents";
import * as portPool from "../port-pool";
import * as repoConfig from "../repo-config";
import { buildProcessTree, clearPortDataForTask, collectDescendants, collectTaskPids, findPortHolders, getLsofOutput, getPortsForTask, getSessionPanePids, parseLsofOutput, scanTaskPorts, waitForPortsFree } from "../port-scanner";
import { getPidCwd, terminatePidsVerified } from "../process-reaper";
import { getResourceUsage } from "../resource-monitor";
import { loadSettings, recordFavoriteUsages } from "../settings";
import { getUserShell } from "../shell-env";
import { spawn } from "../spawn";
import { setupAgentHooks } from "../agent-hooks";
import { ensureArtifactTemplateEnv } from "../artifact-template";
import { ALT_CLICK_PANE_FORMAT, altClickIneligibleReason, computeAltClickKeys, findAltClickPane, parseAltClickPanes } from "../tmux-alt-click";
import { getPushMessage, isActive, buildAgentEnv, buildCmdScript, buildEnvExports, buildScriptRunnerCommand, buildTaskLifecycleEnv, escapeForDoubleQuotes, log, portableReadKey, resolveBinaryPath, shellQuote } from "./shared-pure";
import { resolveOperationalProjectConfig } from "./settings-config";

const devViewerPaneIds = new Map<string, string>();
const fileBrowserPaneIds = new Map<string, string>();
const MAIN_AGENT_PANE_CAPTURE_ATTEMPTS = 10;
const MAIN_AGENT_PANE_CAPTURE_INTERVAL_MS = 100;

function devServerSessionName(taskId: string): string {
	return `dev3-dev-${taskId.slice(0, 8)}`;
}

async function isDevServerRunning(taskId: string, socket: string): Promise<boolean> {
	const devSession = devServerSessionName(taskId);
	// spawnTmux so a launch-time tmux failure surfaces as a typed TmuxSpawnError
	// (clear FDA-pointing message) instead of a raw `posix_spawn ENOENT`. This is
	// the first — and gating — tmux call in the status path, so catching it in
	// buildDevServerStatus covers the whole read.
	const check = pty.spawnTmux(socket, ["has-session", "-t", devSession], { stdout: "pipe", stderr: "pipe" });
	const exitCode = await check.exited;
	return exitCode === 0;
}

async function findDevServerViewerPaneId(taskId: string, taskSession: string, devSession: string, socket: string): Promise<string | null> {
	let viewerPaneId = devViewerPaneIds.get(taskId);
	if (viewerPaneId) {
		return viewerPaneId;
	}

	const listProc = pty.spawnTmux(socket, [
		"list-panes", "-t", taskSession,
		"-F", "#{pane_id} #{pane_start_command}",
	], { stdout: "pipe", stderr: "pipe" });
	const listOutput = await new Response(listProc.stdout).text();
	await listProc.exited;
	for (const line of listOutput.trim().split("\n")) {
		if (!line.includes(devSession)) continue;
		viewerPaneId = line.split(" ")[0];
		break;
	}

	return viewerPaneId ?? null;
}

async function killDevServerViewerPane(taskId: string, taskSession: string, devSession: string, socket: string): Promise<void> {
	const viewerPaneId = await findDevServerViewerPaneId(taskId, taskSession, devSession, socket);
	if (!viewerPaneId) return;

	const killPane = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", viewerPaneId), { stdout: "pipe", stderr: "pipe" });
	await killPane.exited;
	devViewerPaneIds.delete(taskId);
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
): Promise<{ orphanPids: number[]; foreignHolders: PortInfo[] }> {
	const assignedPorts = portPool.getPortAssignments(taskId);
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

export async function killDevServerSession(taskId: string, socket: string, worktreePath?: string | null): Promise<void> {
	const devSession = devServerSessionName(taskId);
	const taskSession = `dev3-${taskId.slice(0, 8)}`;
	// Snapshot the process tree while the dev session still exists — afterwards
	// its pane PIDs are unreachable via tmux.
	const treePids = await collectDevServerTreePids(devSession, socket);
	// Detached/daemonized devScript children are missed by the tree walk — find
	// them by pool-port ownership. Processes in the TASK session tree (agent
	// panes) are excluded: an agent-launched server on a pool port is not the
	// dev server's to kill.
	const taskTreePids = await collectTaskPids(socket, taskSession);
	for (const pid of treePids) taskTreePids.add(pid);
	const { orphanPids, foreignHolders } = await findOrphanedPortHolders(taskId, worktreePath ?? undefined, taskTreePids);
	if (orphanPids.length > 0) {
		log.warn("Reaping detached dev-server processes found via port ownership", { taskId: taskId.slice(0, 8), orphanPids });
	}
	if (foreignHolders.length > 0) {
		log.warn("Assigned ports held by foreign processes — not killing", { taskId: taskId.slice(0, 8), foreignHolders });
	}

	await killDevServerViewerPane(taskId, taskSession, devSession, socket);
	const kill = spawn(pty.tmuxArgs(socket, "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
	await kill.exited;
	const leftovers = await reapDevServerTree([...treePids, ...orphanPids], devSession);

	// "Stop returned" must mean "the next start can bind": wait for the pool
	// ports to actually be released. Ports squatted by foreign processes are
	// excluded — they will never free and are already reported above.
	const foreignPorts = new Set(foreignHolders.map((h) => h.port));
	const waitPorts = portPool.getPortAssignments(taskId).filter((port) => !foreignPorts.has(port));
	const stuckHolders = await waitForPortsFree(waitPorts, DEV_SERVER_PORT_RELEASE_WAIT_MS);
	if (stuckHolders.length > 0) {
		log.warn("Assigned ports still held after teardown", { taskId: taskId.slice(0, 8), stuckHolders });
	}
	clearPortDataForTask(taskId);
	log.info("Killed dev server session", {
		taskId: taskId.slice(0, 8),
		devSession,
		reaped: treePids.length + orphanPids.length,
		leftovers: leftovers.length,
		stuckPorts: stuckHolders.map((h) => h.port),
	});
}

async function buildDevServerStatus(task: Task, projectId: string, hasDevScript: boolean, socket?: string): Promise<DevServerStatus> {
	const resolvedSocket = socket ?? task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
	const taskSessionName = `dev3-${task.id.slice(0, 8)}`;
	const devSessionName = devServerSessionName(task.id);
	// `assignedPorts` comes from the in-memory port pool — no tmux — so it stays
	// available as "last-known state" even when tmux can't be reached.
	const assignedPorts = portPool.getPortAssignments(task.id);

	// A launch-time tmux failure (e.g. macOS Full Disk Access lost) used to crash
	// the read-only status with a raw `posix_spawn ENOENT`. Degrade instead: keep
	// the tmux-free facts, mark the live state unknown, and carry the diagnostic
	// in `tmuxError` for the caller to surface. Non-tmux errors still propagate.
	let running: boolean;
	try {
		running = await isDevServerRunning(task.id, resolvedSocket);
	} catch (err) {
		if (!pty.isTmuxSpawnError(err)) throw err;
		log.error("dev-server status degraded — tmux unreachable", {
			taskId: task.id.slice(0, 8),
			error: err.message,
		});
		return {
			projectId,
			taskId: task.id,
			running: false,
			hasDevScript,
			worktreePath: task.worktreePath ?? null,
			tmuxSocket: resolvedSocket,
			taskSessionName,
			devSessionName,
			viewerPaneId: null,
			panePids: [],
			assignedPorts,
			ports: [],
			devPorts: [],
			portConflicts: [],
			tmuxError: err.message,
		};
	}

	const viewerPaneId = running
		? await findDevServerViewerPaneId(task.id, taskSessionName, devSessionName, resolvedSocket)
		: null;
	const panePids = running ? await getSessionPanePids(resolvedSocket, devSessionName) : [];
	// One live lsof snapshot shared by the dev-port scan, the conflict check,
	// and the whole-task-session fallback below. Skipped entirely when there is
	// nothing to look at (stopped + no assigned ports).
	const lsofOutput = running || assignedPorts.length > 0 ? await getLsofOutput() : "";
	const devTreePids = running ? await collectTaskPids(resolvedSocket, devSessionName) : new Set<number>();
	const devPorts = running && lsofOutput ? parseLsofOutput(lsofOutput, devTreePids) : [];
	// An assigned pool port bound by a PID outside the dev-server tree is a
	// conflict: either a foreign squatter, or (when stopped) a leftover that
	// will make the next start crash-loop on bind.
	const portConflicts = lsofOutput
		? (await findPortHolders(assignedPorts, lsofOutput)).filter((holder) => !devTreePids.has(holder.pid))
		: [];
	const ports = running
		? await (async () => {
			const cached = getPortsForTask(task.id);
			return cached.length > 0 ? cached : scanTaskPorts(resolvedSocket, taskSessionName, lsofOutput);
		})()
		: [];
	const resourceUsage = running ? getResourceUsage(task.id) : undefined;

	return {
		projectId,
		taskId: task.id,
		running,
		hasDevScript,
		worktreePath: task.worktreePath ?? null,
		tmuxSocket: resolvedSocket,
		taskSessionName,
		devSessionName,
		viewerPaneId,
		panePids,
		assignedPorts,
		ports,
		devPorts,
		portConflicts,
		resourceUsage,
	};
}

async function setTmuxSessionPortEnv(taskId: string, socket: string): Promise<void> {
	const ports = portPool.getPortAssignments(taskId);
	if (ports.length === 0) return;

	const tmuxSession = `dev3-${taskId.slice(0, 8)}`;
	const envVars = portPool.buildPortEnv(ports);

	for (const [key, value] of Object.entries(envVars)) {
		const args = pty.tmuxArgs(socket, "set-environment", "-t", tmuxSession, key, value);
		const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
		await proc.exited;
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
 * selectors that codex ≥0.131 rejects and (re)writing the per-profile files. All
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
): Promise<void> {
	try {
		await agents.ensureClaudeTrust(worktreePath, projectPath, accountId);
		log.info("Claude trust ensured", { worktreePath });
	} catch (err) {
		log.error("ensureClaudeTrust failed (non-fatal)", {
			worktreePath,
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
	}

	if (agents.isCodexCommand(resolvedBaseCmd)) {
		try {
			await agents.ensureCodexTrust(worktreePath);
			log.info("Codex trust ensured", { worktreePath });
		} catch (err) {
			log.error("ensureCodexTrust failed (non-fatal)", {
				worktreePath,
				error: String(err),
				stack: (err as Error)?.stack ?? "no stack",
			});
		}
	}

	if (agents.isGeminiCommand(resolvedBaseCmd)) {
		try {
			await agents.ensureGeminiTrust(worktreePath);
			log.info("Gemini trust ensured", { worktreePath });
		} catch (err) {
			log.error("ensureGeminiTrust failed (non-fatal)", {
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
	options?: { stopTarget?: Task["status"]; permissionMode?: PermissionMode },
): Promise<string> {
	try {
		const codexHookOverride = await setupAgentHooks(worktreePath, baseCommand, options);
		if (!codexHookOverride) return command;
		const firstSeparator = command.search(/\s/);
		if (firstSeparator < 0) return `${command} -c ${shellQuote(codexHookOverride)}`;
		return `${command.slice(0, firstSeparator)} -c ${shellQuote(codexHookOverride)}${command.slice(firstSeparator)}`;
	} catch (err) {
		log.warn("setupAgentHooks failed (non-fatal)", {
			worktreePath,
			error: String(err),
		});
		return command;
	}
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

	const ctx: agents.TemplateContext = {
		taskTitle: task.title,
		taskDescription: task.description,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;
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
		}

		// Persist session state as pane[0] for the main agent pane.
		// Skip when reconnecting to an existing tmux session (sessionState is already correct).
		if (!skipSessionPersist) {
			const effectiveSessionId = resume ? sessionId
				: (agents.supportsPreAssignedSessionId(resolvedBaseCmd) ? freshSessionId : null);
			const paneEntry = {
				agentCmd: resolvedBaseCmd,
				sessionId: effectiveSessionId ?? null,
				agentId: agentId ?? task.agentId,
				configId: configId ?? task.configId,
				accountId: task.accountId,
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
	const env = {
		...buildTaskLifecycleEnv(project, task, worktreePath, opts?.branchName),
		...buildAgentEnv(extraEnv, task.id),
		...artifactTemplateEnv,
	};
	const userShell = getUserShell();

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
		const customPath = settings.agentBinaryPaths?.[task.agentId ?? ""];
		const { resolvedPath: binaryPath } = resolveBinaryPath(binaryName, customPath);
		if (!binaryPath) {
			const allAgents = await agents.getAllAgents();
			const matchedAgent = allAgents.find((agent) => agent.baseCommand === resolvedBaseCmd || agent.baseCommand === binaryName);
			const installCmd = matchedAgent?.installCommand ?? `Install "${binaryName}" and make sure it's on your PATH`;

			log.warn("Agent binary not found, creating retry wrapper", { binaryName, installCmd });

			const originalCmdPath = `/tmp/dev3-${task.id}-original-cmd.sh`;
			await Bun.write(originalCmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

			const retryScript = [
				"#!/bin/bash",
				"",
				"check_and_run() {",
				`  if command -v ${shellQuote(binaryName)} &>/dev/null; then`,
				`    printf '\\n\\033[1;32m✓ Found %s\\033[0m\\n\\n' ${shellQuote(binaryName)}`,
				`    exec ${buildScriptRunnerCommand(originalCmdPath, { shellPath: userShell })}`,
				"  fi",
				"}",
				"",
				"while true; do",
				`  printf '\\033[1;31m✗ Agent not found: %s\\033[0m\\n\\n' ${shellQuote(binaryName)}`,
				`  printf '\\033[1mInstall:\\033[0m %s\\n' ${shellQuote(installCmd)}`,
				`  printf '\\033[2mAfter installing, run \"%s\" once in a terminal to log in.\\033[0m\\n' ${shellQuote(binaryName)}`,
				`  printf '\\033[2mInstallation and setup are not managed by dev-3.0.\\033[0m\\n\\n'`,
				"  printf 'Press \\033[1mEnter\\033[0m to retry...\\n'",
				"  read -r",
				"  check_and_run",
				"done",
				"",
			].join("\n");

			const retryScriptPath = `/tmp/dev3-${task.id}-agent-check.sh`;
			await Bun.write(retryScriptPath, retryScript);
			tmuxCmd = buildScriptRunnerCommand(retryScriptPath, { shellPath: userShell });
			log.info("Replaced tmuxCmd with agent-check retry wrapper");
		}
	}

	await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd, task.accountId);

	const stopTarget = project.autoReviewEnabled ? "review-by-ai" : "review-by-user";
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget,
		permissionMode: resolvedPermissionMode,
	});

	let isSetupWrapper = false;
	if (runSetup && project.setupScript.trim()) {
		const setupScriptLaunchMode = project.setupScriptLaunchMode ?? "parallel";
		const prefix = `/tmp/dev3-${task.id}`;
		const setupPath = `${prefix}-setup.sh`;
		const cmdPath = `${prefix}-cmd.sh`;
		const startupPath = `${prefix}-startup.sh`;

		await Bun.write(setupPath, project.setupScript + "\n");
		await Bun.write(cmdPath, buildCmdScript(tmuxCmd, env, { keepShell: true, shellPath: userShell }));

		const splitCmd = `tmux split-window -v -c "${escapeForDoubleQuotes(worktreePath)}" "${escapeForDoubleQuotes(buildScriptRunnerCommand(cmdPath, { shellPath: userShell }))}"`;
		const setupFail = [
			"  printf '\\033[1;31m✗ Setup failed (exit %s)\\033[0m\\n' \"$S\"",
			`  exec ${shellQuote(userShell)}`,
		].join("\n");
		const setupOkClose = [
			"printf '\\033[1;32m✓ Setup done\\033[0m\\n'",
			"printf '\\033[2mClosing in 15s — press any key to close now\\033[0m\\n'",
			// Wrapper runs under the user's login shell (often zsh), so use a
			// shell-portable read — bash's `read -n 1 -s` crashes zsh.
			portableReadKey({ timeoutSeconds: 15 }),
			"exit 0",
		].join("\n");

		const startupLines = [
			"#!/bin/bash",
			...(setupScriptLaunchMode === "parallel" ? [splitCmd] : []),
			buildScriptRunnerCommand(setupPath, { shellPath: userShell, trace: true }),
			"S=$?",
			`if [ $S -ne 0 ]; then`,
			setupFail,
			"fi",
			...(setupScriptLaunchMode === "blocking" ? [splitCmd] : []),
			setupOkClose,
		];
		await Bun.write(startupPath, startupLines.join("\n") + "\n");
		tmuxCmd = buildScriptRunnerCommand(startupPath, { shellPath: userShell });
		isSetupWrapper = true;
	}

	const runScriptPath = `/tmp/dev3-${task.id}-run.sh`;
	await Bun.write(runScriptPath, buildCmdScript(tmuxCmd, env, { keepShell: !isSetupWrapper, shellPath: userShell }));
	const wrapperCmd = buildScriptRunnerCommand(runScriptPath, { shellPath: userShell });

	log.info("Creating PTY session", {
		taskId: task.id.slice(0, 8),
		worktreePath,
		command: tmuxCmd.slice(0, 200),
		scriptPath: runScriptPath,
		envKeys: Object.keys(env),
	});
	try {
		const sessionSocket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		// For virtual ops, only add the split-right shell on a FRESH session — not
		// when reconnecting to an existing one (recovery) — to avoid duplicate panes.
		let sessionPreexisted = false;
		if (project.kind === "virtual") {
			const probe = spawn(pty.tmuxArgs(sessionSocket, "has-session", "-t", `dev3-${task.id.slice(0, 8)}`), { stdout: "ignore", stderr: "ignore" });
			sessionPreexisted = (await probe.exited) === 0;
		}
		pty.createSession(task.id, project.id, worktreePath, wrapperCmd, env, sessionSocket);
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
	const session = `dev3-${task.id.slice(0, 8)}`;
	try {
		let ready = false;
		for (let i = 0; i < 40; i++) {
			const probe = spawn(pty.tmuxArgs(socket, "has-session", "-t", session), { stdout: "ignore", stderr: "ignore" });
			if ((await probe.exited) === 0) { ready = true; break; }
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!ready) {
			log.warn("Virtual shell pane: session never came up, skipping split", { taskId: task.id.slice(0, 8) });
			return;
		}
		const proc = spawn(pty.tmuxArgs(socket,
			"split-window", "-h",
			"-l", "40%",
			"-P", "-F", "#{pane_id}",
			"-e", `DEV3_TASK_ID=${task.id}`,
			"-e", `DEV3_WORKTREE_ROOT=${worktreePath}`,
			"-t", session,
			"-c", worktreePath,
			userShell,
		), { stdout: "pipe", stderr: "pipe" });
		const paneId = (await new Response(proc.stdout).text()).trim();
		const exitCode = await proc.exited;
		if (exitCode === 0 && paneId) {
			spawn(pty.tmuxArgs(socket, "set-option", "-t", session, "pane-border-status", "top")).exited.catch(() => {});
			// `select-pane -t` sets a pane's title but ALSO makes it the active pane.
			// Title the shell first and the agent (pane 0) LAST, awaited in order, so
			// focus deterministically lands on the agent — not the freshly-split shell.
			await spawn(pty.tmuxArgs(socket, "select-pane", "-t", paneId, "-T", "Shell")).exited.catch(() => {});
			await spawn(pty.tmuxArgs(socket, "select-pane", "-t", `${session}.0`, "-T", "Agent")).exited.catch(() => {});
			log.info("Virtual shell pane created", { taskId: task.id.slice(0, 8), paneId });
		} else {
			log.warn("Virtual shell pane split failed (non-fatal)", { taskId: task.id.slice(0, 8), exitCode });
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
	const prompt = rawPrompt.replace(/\{baseBranch\}/g, `origin/${baseBranch}`);

	log.info("launchColumnAgent START", {
		taskId: task.id.slice(0, 8),
		agentId,
		configId,
		paneTitle: options.paneTitle,
	});

	const socket = pty.getSessionSocket(task.id);
	const tmuxSession = `dev3-${task.id.slice(0, 8)}`;

	const ctx: agents.TemplateContext = {
		taskTitle: `${options.paneTitle}: ${task.title}`,
		taskDescription: prompt,
		projectName: project.name,
		projectPath: project.path,
		worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
	let resolvedPermissionMode: PermissionMode | undefined;

	try {
		const resolved = await agents.resolveCommandForAgent(agentId, configId, ctx, { skipSystemPrompt: true });
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		resolvedPermissionMode = resolved.config?.permissionMode;
	} catch (err) {
		log.error("launchColumnAgent: failed to resolve command", { error: String(err) });
		throw err;
	}
	await ensureAgentTrust(worktreePath, project.path, resolvedBaseCmd);
	tmuxCmd = await applyAgentHooksToCommand(worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
		permissionMode: resolvedPermissionMode,
	});

	const env = {
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, worktreePath),
	};
	const scriptPath = `/tmp/dev3-${task.id}-col-agent.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env, {
		paneTitle: options.paneTitle,
		onExitCommand: options.onExitCommand,
	}));

	const paneFile = `/tmp/dev3-${task.id}-col-agent-pane`;
	try {
		const oldPaneId = (await Bun.file(paneFile).text()).trim();
		if (oldPaneId) {
			log.info("launchColumnAgent: killing old pane", { paneId: oldPaneId });
			const killArgs = pty.tmuxArgs(socket, "kill-pane", "-t", oldPaneId);
			const killProc = spawn(killArgs, { stdout: "pipe", stderr: "pipe" });
			await killProc.exited;
		}
	} catch {}

	const splitArgs = pty.tmuxArgs(
		socket, "split-window",
		"-h", "-l", "40%",
		"-P", "-F", "#{pane_id}",
		"-e", `DEV3_TASK_ID=${task.id}`,
		"-e", `DEV3_WORKTREE_ROOT=${worktreePath}`,
		"-t", tmuxSession,
		"-c", worktreePath,
		`bash "${scriptPath}"`,
	);
	const proc = spawn(splitArgs, { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("launchColumnAgent: tmux split-window failed", { exitCode, stderr: stderr.trim() });
		throw new Error(`tmux split-window failed: ${stderr.trim() || "unknown error"}`);
	}

	const newPaneId = stdout.trim();
	if (newPaneId) {
		await Bun.write(paneFile, newPaneId);
		log.info("launchColumnAgent: pane created", { paneId: newPaneId });
	}

	try {
		const focusArgs = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.0`);
		const focusProc = spawn(focusArgs, { stdout: "pipe", stderr: "pipe" });
		await focusProc.exited;
	} catch {}

	log.info("launchColumnAgent DONE", { taskId: task.id.slice(0, 8) });
}

export function cleanupTaskTmuxState(taskId: string): void {
	fileBrowserPaneIds.delete(taskId);
	devViewerPaneIds.delete(taskId);
}

export async function runDevServer(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ runDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);

		if (!resolved.devScript.trim()) throw new Error("No dev script configured");
		if (!task.worktreePath) throw new Error("Task has no worktree");

		const devSession = devServerSessionName(task.id);
		const devScriptPath = `/tmp/dev3-${task.id}-dev.sh`;
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;

		if (await isDevServerRunning(task.id, socket)) {
			await killDevServerSession(task.id, socket, task.worktreePath);
		}

		// Ensure pool ports exist for this task before launching. allocatePorts is
		// idempotent (returns the existing set when the count matches), so this also
		// back-fills tasks whose worktree was created before Port Allocation
		// (portCount) was configured — otherwise the dev app's remote web server
		// (DEV3_REMOTE_PORT=${DEV3_PORT0:-0}) could never bind a deterministic port
		// on such a task without recreating the worktree. See decision 093.
		const portCount = resolved.portCount ?? 0;
		let devPorts = portPool.getPortAssignments(task.id);
		if (portCount > 0 && devPorts.length !== portCount) {
			try {
				devPorts = await portPool.allocatePorts(task.id, portCount);
				log.info("Dev-server allocated pool ports", { taskId: task.id.slice(0, 8), ports: devPorts });
			} catch (err) {
				log.error("Dev-server port allocation failed (non-fatal)", {
					taskId: task.id.slice(0, 8), portCount, error: String(err),
				});
			}
		}
		// Surface "port already in use" at start time instead of leaving the
		// devScript to crash-loop on bind with only a downstream 502 as evidence.
		// The start still proceeds (the script may not use the squatted port) —
		// the conflict is logged here and returned in the status' portConflicts.
		const preStartConflicts = await findPortHolders(devPorts);
		if (preStartConflicts.length > 0) {
			log.warn("Assigned ports already in use before dev-server start", {
				taskId: task.id.slice(0, 8),
				conflicts: preStartConflicts,
			});
		}

		const portExports = devPorts.length > 0
			? buildEnvExports(portPool.buildPortEnv(devPorts)).join("\n") + "\n"
			: "";
		// Same workspace env the setup/cleanup hooks get, so a devScript can
		// reference root-resolved hooks ("$DEV3_PROJECT_PATH/...") too.
		const lifecycleExports = buildEnvExports(buildTaskLifecycleEnv(project, task, task.worktreePath)).join("\n") + "\n";

		const wrappedScript = [
			`#!/bin/bash`,
			lifecycleExports,
			...(portExports ? [portExports] : []),
			`set -x`,
			resolved.devScript,
			`EXIT_CODE=$?`,
			`set +x`,
			`if [ $EXIT_CODE -ne 0 ]; then`,
			`  echo ""`,
			`  echo "Process exited with code $EXIT_CODE. Press any key to close."`,
			`  read -n 1 -s`,
			`fi`,
			`# Detach the outer viewer pane before this pane closes so inner tmux redraws`,
			`# without a watching client — prevents escape sequence corruption in outer tmux.`,
			`# Use the app-resolved binary: a PATH tmux of a different version cannot`,
			`# talk to this server at all ("server exited unexpectedly").`,
			`"${pty.getTmuxBinary()}" detach-client 2>/dev/null || true`,
		].join("\n") + "\n";
		await Bun.write(devScriptPath, wrappedScript);

		const proc = spawn(pty.tmuxArgs(socket,
			"new-session", "-d",
			"-e", `DEV3_TASK_ID=${task.id}`,
			"-e", `DEV3_WORKTREE_ROOT=${task.worktreePath}`,
			"-s", devSession,
			"-c", task.worktreePath,
			`bash "${devScriptPath}"`,
			// Client cwd must never be a mortal worktree — a tmux server started
			// by this client keeps that cwd forever (see pty.tmuxClientCwd).
		), { stdout: "pipe", stderr: "pipe", cwd: pty.tmuxClientCwd() });
		const stderrOutput = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (stderrOutput.trim()) {
			log.warn("runDevServer tmux stderr", { taskId: task.id.slice(0, 8), stderr: stderrOutput.trim() });
		}
		if (exitCode !== 0) {
			log.error("runDevServer tmux exited with non-zero code", { taskId: task.id.slice(0, 8), exitCode, stderr: stderrOutput.trim() });
			throw new Error(`tmux new-session failed (exit ${exitCode}): ${stderrOutput.trim() || "unknown error"}`);
		}

		const taskSession = `dev3-${task.id.slice(0, 8)}`;
		// These shell snippets must use the app-resolved tmux binary, not bare
		// `tmux` from PATH: a client of a different version cannot talk to the
		// server it targets ("server exited unexpectedly").
		const tmuxBin = pty.getTmuxBinary();
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
		const viewerProc = spawn(pty.tmuxArgs(socket,
			"split-window", "-h",
			"-e", `DEV3_TASK_ID=${task.id}`,
			"-e", `DEV3_WORKTREE_ROOT=${task.worktreePath}`,
			"-t", taskSession,
			"-c", task.worktreePath,
			"-l", "50%",
			"-P", "-F", "#{pane_id}",
			attachCmd,
		), { stdout: "pipe", stderr: "pipe" });
		const viewerOut = await new Response(viewerProc.stdout).text();
		await viewerProc.exited;
		const viewerPaneId = viewerOut.trim();

		if (viewerPaneId) {
			devViewerPaneIds.set(task.id, viewerPaneId);
			spawn(pty.tmuxArgs(socket, "select-pane", "-t", viewerPaneId, "-T", "Dev Server  (Ctrl+b Ctrl+b to control inner)")).exited.catch(() => {});
			spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "top")).exited.catch(() => {});
		}

		log.info("← runDevServer done", { devSession, viewerPaneId });
		return buildDevServerStatus(task, project.id, !!resolved.devScript.trim(), socket);
	} catch (err) {
		log.error("runDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
			stack: (err as Error)?.stack ?? "no stack",
		});
		throw err;
	}
}

async function checkDevServer(params: { taskId: string; projectId: string }): Promise<{ running: boolean }> {
	log.info("→ checkDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		const running = await isDevServerRunning(task.id, socket);
		log.info("← checkDevServer", { running });
		return { running };
	} catch {
		return { running: false };
	}
}

export async function stopDevServer(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ stopDevServer", params);
	try {
		const project = await data.getProject(params.projectId);
		const task = await data.getTask(project, params.taskId);
		const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		await killDevServerSession(task.id, socket, task.worktreePath);
		const taskSession = `dev3-${task.id.slice(0, 8)}`;
		spawn(pty.tmuxArgs(socket, "set-option", "-t", taskSession, "pane-border-status", "off")).exited.catch(() => {});
		log.info("← stopDevServer done");
		return buildDevServerStatus(task, project.id, !!resolved.devScript.trim(), socket);
	} catch (err) {
		log.error("stopDevServer FAILED", {
			taskId: params.taskId.slice(0, 8),
			error: String(err),
		});
		throw err;
	}
}

// stopDevServer already VERIFIES teardown (processes confirmed dead, pool
// ports confirmed released), so restart no longer needs a long blind sleep.
// A short buffer remains only for the inner tmux session/client to finish
// tearing down, avoiding redraw glitches in the viewer pane.
const DEV_SERVER_RESTART_DELAY_MS = 250;

export async function restartDevServer(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ restartDevServer", params);
	await stopDevServer(params);
	await new Promise((resolve) => setTimeout(resolve, DEV_SERVER_RESTART_DELAY_MS));
	const status = await runDevServer(params);
	log.info("← restartDevServer done");
	return status;
}

export async function getDevServerStatus(params: { taskId: string; projectId: string }): Promise<DevServerStatus> {
	log.info("→ getDevServerStatus", params);
	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);
	const resolved = await resolveOperationalProjectConfig(project, task.worktreePath ?? undefined);
	const status = await buildDevServerStatus(task, project.id, !!resolved.devScript.trim());
	log.info("← getDevServerStatus", { running: status.running, ports: status.ports.length });
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

		const tmuxSession = `dev3-${task.id.slice(0, 8)}`;
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
		const existingPane = fileBrowserPaneIds.get(task.id);
		if (existingPane) {
			const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", existingPane));
			await kill.exited;
			fileBrowserPaneIds.delete(task.id);
			log.info("← openFileBrowser: toggled off (killed pane)", { taskId: task.id.slice(0, 8), paneId: existingPane });
			return;
		}

		const listProc = spawn(pty.tmuxArgs(socket,
			"list-panes", "-t", tmuxSession,
			"-F", "#{pane_id} #{pane_current_command}",
		), { stdout: "pipe", stderr: "pipe" });
		const listOutput = await new Response(listProc.stdout).text();
		await listProc.exited;
		for (const line of listOutput.trim().split("\n")) {
			if (!line.includes("yazi")) continue;
			const paneId = line.split(" ")[0];
			const kill = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", paneId));
			await kill.exited;
			log.info("← openFileBrowser: toggled off (found running yazi)", { taskId: task.id.slice(0, 8), paneId });
			return;
		}

		const proc = spawn(pty.tmuxArgs(socket,
			"split-window", "-v",
			"-t", tmuxSession,
			"-c", task.worktreePath,
			"-l", "30%",
			"-P", "-F", "#{pane_id}",
			"yazi",
		), { stdout: "pipe", stderr: "pipe" });
		const output = await new Response(proc.stdout).text();
		const stderrOutput = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			log.error("openFileBrowser tmux failed", { taskId: task.id.slice(0, 8), exitCode, stderr: stderrOutput.trim() });
			throw new Error(`tmux split-window failed: ${stderrOutput.trim() || "unknown error"}`);
		}

		const paneId = output.trim();
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
		pty.destroySession(params.taskId);
	}

	// If session is in memory (alive or dead), verify the tmux session still
	// exists. When the tmux server is killed externally, the proc may or may
	// not have exited yet — but `has-session` is the ground truth.
	if (pty.hasSession(params.taskId)) {
		const socket = pty.getSessionSocket(params.taskId);
		if (!(await pty.tmuxSessionExists(params.taskId, socket))) {
			log.info("Session in memory but tmux session gone — destroying for recovery", {
				taskId: params.taskId.slice(0, 8),
			});
			pty.destroySession(params.taskId);
		}
	}

	// If no PTY session in memory, try to recreate it from persisted task data
	if (!pty.hasSession(params.taskId)) {
		log.info("No PTY session in memory, attempting to restore", {
			taskId: params.taskId.slice(0, 8),
		});

		const { task: foundTask, project: foundProject } = await findTaskAcrossProjects(params.taskId);

		if (foundTask && foundProject && isActive(foundTask.status) && foundTask.worktreePath) {
			const socket = foundTask.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
			const tmuxAlive = await pty.tmuxSessionExists(params.taskId, socket);

			if (tmuxAlive) {
				// Tmux session exists — just reconnect (no resume needed).
				// Skip session persist so we don't overwrite the real session ID.
				try {
					// Virtual boards have no git repo config to resolve — pass through.
					const resolvedProject = foundProject.kind === "virtual"
						? foundProject
						: await repoConfig.resolveProjectConfig(foundProject, foundTask.worktreePath);
					await launchTaskPty(resolvedProject, foundTask, foundTask.worktreePath, foundTask.agentId, foundTask.configId, false, false, { skipSessionPersist: true });
					log.info("Reconnected to existing tmux session", { taskId: params.taskId.slice(0, 8) });
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

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		pty.destroySession(params.taskId);
	}

	// Launch main pane (panes[0]) with resume
	const main = panes[0];
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
		main.sessionId ? { sessionId: main.sessionId } : undefined,
	);

	// Resume extra panes (panes[1..]) via split-window.
	// Wait for the tmux session to be ready before splitting.
	if (panes.length > 1) {
		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
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
					const cmdOpts: agents.CommandOptions = { resume: true, accountId: pane.accountId };
					if (pane.sessionId) cmdOpts.sessionId = pane.sessionId;
					let resumeCmd: string;
					let resumeBaseCmd = pane.agentCmd;
					let extraEnv: Record<string, string> = {};
					if (pane.agentId) {
						const resolved = await agents.resolveCommandForAgent(pane.agentId, pane.configId, ctx, cmdOpts);
						resumeCmd = resolved.command;
						extraEnv = resolved.extraEnv;
						resumeBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || pane.agentCmd;
					} else {
						resumeCmd = agents.buildResumeCommand(pane.agentCmd, pane.sessionId ?? undefined) ?? pane.agentCmd;
					}
					await ensureAgentTrust(task.worktreePath, project.path, resumeBaseCmd, pane.accountId);
					resumeCmd = await applyAgentHooksToCommand(task.worktreePath, resumeBaseCmd, resumeCmd, {
						stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
					});
					const scriptPath = `/tmp/dev3-${params.taskId}-resume-pane-${i}.sh`;
					await Bun.write(scriptPath, buildCmdScript(resumeCmd, extraEnv, { keepShell: true }));
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

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		pty.destroySession(params.taskId);
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

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← restartTask", { url });
	return url;
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
		pty.createSession(sessionKey, params.projectId, project.path, getUserShell(), {}, pty.DEFAULT_TMUX_SOCKET, "project");
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

	const format = "#{session_name}|#{pane_current_path}|#{session_windows}|#{session_created}";
	const proc = spawn(pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "list-sessions", "-F", format), { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.debug("← listTmuxSessions (no tmux server or error)", { exitCode });
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

	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const [name, cwd, windowsStr, createdStr] = line.split("|");
		if (!name.startsWith("dev3-")) continue;
		if (name.startsWith("dev3-dev-")) continue;
		// Ignore a stale single home terminal session from an older app version
		// (the home terminal was replaced by the Quick-shell operation).
		if (name === "dev3-home") continue;

		const isCleanup = name.startsWith("dev3-cl-");
		const isProjectTerminal = name.startsWith("dev3-pt-");
		const shortId = isProjectTerminal
			? name.slice(8)
			: isCleanup
				? name.slice(8)
				: name.slice(5);
		if (!shortId) continue;

		rawSessions.push({
			name,
			cwd: cwd || "",
			createdAt: parseInt(createdStr, 10) || 0,
			windowCount: parseInt(windowsStr, 10) || 1,
			isCleanup,
			isProjectTerminal,
			shortId,
		});

		if (isProjectTerminal) {
			projectShortIds.add(shortId);
		} else {
			taskShortIds.add(shortId);
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

async function killTmuxSession(params: { sessionName: string }): Promise<void> {
	log.info("→ killTmuxSession", { sessionName: params.sessionName });
	if (!params.sessionName.startsWith("dev3-")) {
		throw new Error("Can only kill dev3-* sessions");
	}
	const proc = spawn(
		pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "kill-session", "-t", params.sessionName),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("killTmuxSession failed", { sessionName: params.sessionName, stderr: stderr.trim() });
		throw new Error(`Failed to kill session: ${stderr.trim()}`);
	}

	if (!params.sessionName.startsWith("dev3-dev-")) {
		const devSession = `dev3-dev-${params.sessionName.slice("dev3-".length)}`;
		// Same orphaned-children problem as the Stop button: snapshot the dev
		// server's process tree before tearing the session down, then reap it
		// with verification. (No full task ID here, so the port-ownership orphan
		// sweep is skipped — the tree reap covers the common case.)
		const treePids = await collectDevServerTreePids(devSession, pty.DEFAULT_TMUX_SOCKET);
		const devKill = spawn(pty.tmuxArgs(pty.DEFAULT_TMUX_SOCKET, "kill-session", "-t", devSession), { stdout: "pipe", stderr: "pipe" });
		await devKill.exited;
		await reapDevServerTree(treePids, devSession);
		log.info("killTmuxSession: killed dev server session (best-effort)", { devSession });
	}

	log.info("← killTmuxSession done", { sessionName: params.sessionName });
}

async function tmuxAction(params: { taskId: string; action: "splitH" | "splitV" | "zoom" | "killPane" | "nextPane" | "prevPane" | "newWindow" | "nextLayout" | "layoutTiled" | "layoutEvenH" | "layoutEvenV" | "layoutMainH" | "layoutMainV"; force?: boolean }): Promise<void> {
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
				const countProc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
				const countStdout = await new Response(countProc.stdout).text();
				const countExit = await countProc.exited;
				if (countExit === 0) {
					const paneCount = countStdout.trim().split("\n").filter((l) => l.length > 0).length;
					if (paneCount <= 1) {
						log.info("tmuxAction killPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
						return;
					}
				}
			} catch { /* best effort — if counting fails, fall through to the normal kill */ }
		}

		try {
			const idProc = spawn(pty.tmuxArgs(socket, "display-message", "-t", tmuxSession, "-p", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
			const idStdout = await new Response(idProc.stdout).text();
			const idExit = await idProc.exited;
			if (idExit === 0) {
				killedPaneId = idStdout.trim() || null;
			}
		} catch { /* best effort */ }
	}

	let args: string[];
	switch (params.action) {
		case "splitH":
			args = pty.tmuxArgs(socket, "split-window", "-v", "-c", pty.PANE_CWD_FORMAT, "-t", tmuxSession);
			break;
		case "splitV":
			args = pty.tmuxArgs(socket, "split-window", "-h", "-c", pty.PANE_CWD_FORMAT, "-t", tmuxSession);
			break;
		case "zoom":
			args = pty.tmuxArgs(socket, "resize-pane", "-Z", "-t", tmuxSession);
			break;
		case "killPane":
			args = pty.tmuxArgs(socket, "kill-pane", "-t", tmuxSession);
			break;
		case "nextPane":
			args = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.+`);
			break;
		case "prevPane":
			args = pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.-`);
			break;
		case "newWindow":
			args = pty.tmuxArgs(socket, "new-window", "-c", pty.PANE_CWD_FORMAT, "-t", tmuxSession);
			break;
		case "nextLayout":
			args = pty.tmuxArgs(socket, "next-layout", "-t", tmuxSession);
			break;
		case "layoutTiled":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "tiled");
			break;
		case "layoutEvenH":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "even-vertical");
			break;
		case "layoutEvenV":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "even-horizontal");
			break;
		case "layoutMainH":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "main-horizontal");
			break;
		case "layoutMainV":
			args = pty.tmuxArgs(socket, "select-layout", "-t", tmuxSession, "main-vertical");
			break;
	}

	const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("tmuxAction failed", { action: params.action, exitCode, stderr: stderr.trim() });
		throw new Error(`tmux ${params.action} failed: ${stderr.trim() || "unknown error"}`);
	}

	// Remove killed pane from sessionState
	if (params.action === "killPane" && killedPaneId) {
		handlePaneExited(params.taskId, killedPaneId).catch((err) => {
			log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
		});
	}

	log.info("← tmuxAction done", { taskId: params.taskId.slice(0, 8), action: params.action });
}

async function tmuxPaneCount(params: { taskId: string }): Promise<{ count: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = pty.getSessionTmuxName(params.taskId);
	try {
		const proc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { count: 0 };
		}
		const count = stdout.trim().split("\n").filter((l) => l.length > 0).length;
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
async function tmuxKillPane(params: { taskId: string; paneId: string; force?: boolean }): Promise<{ killed: boolean }> {
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
			const countProc = spawn(pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id}"), { stdout: "pipe", stderr: "pipe" });
			const countStdout = await new Response(countProc.stdout).text();
			const countExit = await countProc.exited;
			if (countExit === 0) {
				const paneCount = countStdout.trim().split("\n").filter((l) => l.length > 0).length;
				if (paneCount <= 1) {
					log.info("tmuxKillPane refused — last pane in session", { taskId: params.taskId.slice(0, 8), paneCount });
					return { killed: false };
				}
			}
		} catch { /* best effort — if counting fails, fall through to the normal kill */ }
	}

	const proc = spawn(pty.tmuxArgs(socket, "kill-pane", "-t", params.paneId), { stdout: "pipe", stderr: "pipe" });
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		log.error("tmuxKillPane failed", { paneId: params.paneId, exitCode, stderr: stderr.trim() });
		throw new Error(`tmux kill-pane failed: ${stderr.trim() || "unknown error"}`);
	}

	// kill-pane does NOT trigger tmux's pane-exited hook, so clean up sessionState here.
	handlePaneExited(params.taskId, params.paneId).catch((err) => {
		log.warn("Failed to clean up killed pane from sessionState", { error: String(err) });
	});

	log.info("← tmuxKillPane done", { taskId: params.taskId.slice(0, 8), paneId: params.paneId });
	return { killed: true };
}

interface PaneLayoutInfo {
	count: number;
	activeIndex: number;
	zoomed: boolean;
	paneIds: string[];
	labels: string[];
}

// Field separator for list-panes output: pane_title can contain spaces, so a
// space-delimited format is unparseable. \x1f (unit separator) never appears in
// a command name, title, or hostname.
const PANE_FIELD_SEP = "\x1f";
const PANE_LAYOUT_FORMAT = [
	"#{pane_id}",
	"#{pane_active}",
	"#{window_zoomed_flag}",
	"#{pane_current_command}",
	"#{host_short}",
	"#{pane_title}",
].join(PANE_FIELD_SEP);

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
async function readPaneLayout(socket: string, tmuxSession: string): Promise<PaneLayoutInfo> {
	try {
		const proc = spawn(
			pty.tmuxArgs(socket, "list-panes", "-t", tmuxSession, "-F", PANE_LAYOUT_FORMAT),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return { count: 0, activeIndex: 0, zoomed: false, paneIds: [], labels: [] };

		const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
		const paneIds: string[] = [];
		const labels: string[] = [];
		let activeIndex = 0;
		let zoomed = false;
		lines.forEach((line, i) => {
			const [paneId, active, zoom, cmd, hostShort, title] = line.split(PANE_FIELD_SEP);
			paneIds.push(paneId);
			const trimmedTitle = (title ?? "").trim();
			const meaningfulTitle = trimmedTitle && trimmedTitle !== (hostShort ?? "").trim() ? trimmedTitle : "";
			labels.push(meaningfulTitle || (cmd ?? "").trim() || "");
			if (active === "1") {
				activeIndex = i;
				zoomed = zoom === "1";
			}
		});
		return { count: lines.length, activeIndex, zoomed, paneIds, labels };
	} catch {
		return { count: 0, activeIndex: 0, zoomed: false, paneIds: [], labels: [] };
	}
}

async function runTmuxQuiet(args: string[]): Promise<void> {
	const proc = spawn(args, { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
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
async function tmuxPaneNavigate(params: {
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
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.+`));
			navigated = true;
		} else if (params.step === "prev") {
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-pane", "-t", `${tmuxSession}:.-`));
			navigated = true;
		} else if (typeof params.index === "number" && info.paneIds[params.index]) {
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-pane", "-t", info.paneIds[params.index]));
			navigated = true;
		} else if (params.paneId && info.paneIds.includes(params.paneId)) {
			// Jump-by-id (the pane-map sheet taps a specific box). Robust against
			// any index/order drift between the map's layout and this read.
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-pane", "-t", params.paneId));
			navigated = true;
		}
		// Re-read after a move: select-pane changes the active pane AND auto-unzooms.
		if (navigated) info = await readPaneLayout(socket, tmuxSession);
	}

	// Enforce zoom intent idempotently (single pane needs no zoom — it already fills the window).
	let zoomed = info.zoomed;
	if (info.count > 1 && typeof params.zoom === "boolean" && params.zoom !== info.zoomed) {
		await runTmuxQuiet(pty.tmuxArgs(socket, "resize-pane", "-Z", "-t", tmuxSession));
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

// Field separator for list-windows output: window_name can contain spaces, so a
// space-delimited format is unparseable. \x1f (unit separator) never appears in
// a window id or name.
const WINDOW_FIELD_SEP = "\x1f";
const WINDOW_LAYOUT_FORMAT = [
	"#{window_id}",
	"#{window_active}",
	"#{window_name}",
].join(WINDOW_FIELD_SEP);

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
		const proc = spawn(
			pty.tmuxArgs(socket, "list-windows", "-t", tmuxSession, "-F", WINDOW_LAYOUT_FORMAT),
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return { count: 0, activeIndex: 0, windowIds: [], labels: [] };

		const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
		const windowIds: string[] = [];
		const labels: string[] = [];
		let activeIndex = 0;
		lines.forEach((line, i) => {
			const [windowId, active, name] = line.split(WINDOW_FIELD_SEP);
			windowIds.push(windowId);
			labels.push((name ?? "").trim());
			if (active === "1") activeIndex = i;
		});
		return { count: lines.length, activeIndex, windowIds, labels };
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
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-window", "-t", `${tmuxSession}:+`));
			navigated = true;
		} else if (params.step === "prev") {
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-window", "-t", `${tmuxSession}:-`));
			navigated = true;
		} else if (typeof params.index === "number" && info.windowIds[params.index]) {
			await runTmuxQuiet(pty.tmuxArgs(socket, "select-window", "-t", info.windowIds[params.index]));
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
	const listProc = spawn(
		pty.tmuxArgs(socket, "list-panes", "-t", tmuxSession, "-F", ALT_CLICK_PANE_FORMAT),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const listOut = await new Response(listProc.stdout).text();
	if ((await listProc.exited) !== 0) return { moved: false };

	const pane = findAltClickPane(parseAltClickPanes(listOut), x0, y0);
	if (!pane) return { moved: false };

	const reason = altClickIneligibleReason(pane);
	if (reason) {
		log.debug("tmuxAltClickMoveCursor skipped", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, reason });
		return { moved: false };
	}

	// Row text of the cursor line — clamps the target to end-of-input so a
	// click in the blank area right of the text lands exactly at EOL.
	let rowText = "";
	const capProc = spawn(
		pty.tmuxArgs(socket, "capture-pane", "-p", "-t", pane.paneId, "-S", String(pane.cursorY), "-E", String(pane.cursorY)),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const capOut = await new Response(capProc.stdout).text();
	if ((await capProc.exited) === 0) rowText = capOut.replace(/\n$/, "");

	const plan = computeAltClickKeys(pane, x0, y0, rowText);
	if (!plan) return { moved: false };

	// Focus the clicked pane (alt-clicks bypass tmux's own MouseDown1Pane
	// select-pane binding). Skip when already active — select-pane would
	// needlessly unzoom a zoomed window (see tmuxPaneNavigate gotcha).
	if (!pane.active) {
		await runTmuxQuiet(pty.tmuxArgs(socket, "select-pane", "-t", pane.paneId));
	}
	await runTmuxQuiet(
		pty.tmuxArgs(socket, "send-keys", "-t", pane.paneId, ...Array<string>(plan.count).fill(plan.key)),
	);
	log.info("← tmuxAltClickMoveCursor", { taskId: params.taskId.slice(0, 8), pane: pane.paneId, key: plan.key, count: plan.count });
	return { moved: true };
}

async function exitCopyModeInSession(socket: string, tmuxSession: string): Promise<number> {
	const listProc = spawn(
		pty.tmuxArgs(socket, "list-panes", "-s", "-t", tmuxSession, "-F", "#{pane_id} #{pane_in_mode}"),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const listOutput = await new Response(listProc.stdout).text();
	const listExit = await listProc.exited;
	if (listExit !== 0) {
		return 0;
	}

	const panesInMode: string[] = [];
	for (const line of listOutput.trim().split("\n")) {
		if (!line) continue;
		const [paneId, inMode] = line.split(" ");
		if (paneId && inMode === "1") {
			panesInMode.push(paneId);
		}
	}

	for (const paneId of panesInMode) {
		const cancelProc = spawn(
			pty.tmuxArgs(socket, "send-keys", "-t", paneId, "-X", "cancel"),
			{ stdout: "pipe", stderr: "pipe" },
		);
		await cancelProc.exited;
	}

	return panesInMode.length;
}

async function exitCopyModeAllPanes(params: { taskId: string }): Promise<{ panesExited: number }> {
	const socket = pty.getSessionSocket(params.taskId);
	const taskSession = pty.getSessionTmuxName(params.taskId);
	const devSession = devServerSessionName(params.taskId);

	// dev-server lives in a separate tmux session (dev3-dev-<id>) — the user's
	// scroll-mode is typically there, not in the agent session. Hit both.
	const sessions: string[] = [];
	if (await pty.tmuxSessionExists(params.taskId, socket)) {
		sessions.push(taskSession);
	}
	if (await isDevServerRunning(params.taskId, socket)) {
		sessions.push(devSession);
	}

	let total = 0;
	for (const session of sessions) {
		total += await exitCopyModeInSession(socket, session);
	}

	if (total > 0) {
		log.info("Exited copy-mode in panes", { taskId: params.taskId.slice(0, 8), count: total, sessions });
	}
	return { panesExited: total };
}

async function spawnAgentInTask(params: { taskId: string; projectId: string; agentId: string | null; configId: string | null; accountId?: string | null }): Promise<void> {
	log.info("→ spawnAgentInTask", { taskId: params.taskId.slice(0, 8), agentId: params.agentId, configId: params.configId });

	const project = await data.getProject(params.projectId);
	const task = await data.getTask(project, params.taskId);

	if (!task.worktreePath) {
		throw new Error("Task has no worktree — cannot spawn agent");
	}

	const ctx: agents.TemplateContext = {
		taskTitle: "",
		taskDescription: "",
		projectName: project.name,
		projectPath: project.path,
		worktreePath: task.worktreePath,
	};

	let tmuxCmd: string;
	let extraEnv: Record<string, string>;
	let resolvedBaseCmd = "";
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
		launchedAgentId = resolved.agent?.id ?? params.agentId;
		launchedConfigId = resolved.config?.id ?? params.configId;
	} else {
		const resolved = await agents.resolveCommandForProject(
			project,
			task.title,
			task.description,
			task.worktreePath,
			undefined,
			cmdOptions,
		);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Register trust / re-patch the agent's config before spawning. The primary
	// task launch does this; without it a spawned Codex pane runs against a stale
	// config.toml and crashes on the legacy-profile check (see ensureAgentTrust).
	await ensureAgentTrust(task.worktreePath, project.path, resolvedBaseCmd, params.accountId);
	tmuxCmd = await applyAgentHooksToCommand(task.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
	});

	const env: Record<string, string> = {
		...buildAgentEnv(extraEnv, task.id),
		...ensureArtifactTemplateEnv(project, task, task.worktreePath),
	};

	const existingPorts = portPool.getPortAssignments(task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = `/tmp/dev3-${task.id}-spawn-${Date.now()}.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env));

	const socket = pty.getSessionSocket(params.taskId);
	const tmuxSession = `dev3-${params.taskId.slice(0, 8)}`;
	const args = pty.tmuxArgs(socket, "split-window", "-h", "-P", "-F", "#{pane_id}", "-e", `DEV3_TASK_ID=${task.id}`, "-e", `DEV3_WORKTREE_ROOT=${task.worktreePath}`, "-c", task.worktreePath, "-t", tmuxSession, `bash "${scriptPath}"`);
	const proc = spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		log.error("spawnAgentInTask failed", { exitCode, stderr: stderr.trim() });
		throw new Error(`Failed to spawn agent: ${stderr.trim() || "unknown error"}`);
	}

	const newPaneId = stdout.trim() || null;

	// Append this pane to sessionState for recovery
	const paneEntry = {
		paneId: newPaneId,
		agentCmd: resolvedBaseCmd,
		sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd) ? freshSessionId : null,
		agentId: launchedAgentId,
		configId: launchedConfigId,
		accountId: params.accountId,
	};
	const existingPanes = task.sessionState?.panes ?? [];
	try {
		const updated = await data.updateTask(project, task.id, {
			agentId: launchedAgentId,
			configId: launchedConfigId,
			sessionState: { panes: [...existingPanes, paneEntry] },
		});
		getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
		log.info("Appended pane to sessionState", { taskId: params.taskId.slice(0, 8), paneCount: existingPanes.length + 1 });
	} catch (err) {
		log.error("Failed to append pane to sessionState (non-fatal)", { error: String(err) });
	}

	// Bump the favorite usage counter if this launched combo is starred (best-effort).
	void recordFavoriteUsages([{ agentId: launchedAgentId, configId: launchedConfigId }]);

	log.info("← spawnAgentInTask done", { taskId: params.taskId.slice(0, 8) });
}

const BUG_HUNTER_AUTOTYPE_DELAY_MS = 5000;
const BUG_HUNTER_ENTER_DELAY_MS = 800;

// Resolve the comparison ref for bug-hunter scoping, mirroring the renderer's
// getDefaultTaskCompareRef (src/mainview/components/task-info-panel/useTaskBranchStatus.ts)
// so the lightbox path honors the project's configured compare ref instead of
// always assuming origin/<base>.
export function resolveBugHunterCompareRef(task: Task, project: Project): string {
	const projectBaseBranch = project.defaultBaseBranch || "main";
	const taskBaseBranch = task.baseBranch || projectBaseBranch;
	// Task forked from a non-default base → compare against that local branch.
	if (taskBaseBranch !== projectBaseBranch) return taskBaseBranch;
	if (project.defaultCompareRef) return project.defaultCompareRef;
	if (project.defaultCompareRefMode === "local") return taskBaseBranch;
	return `origin/${taskBaseBranch}`;
}

export function buildBugHunterPrompt(task: Task, project: Project, baseCmd = ""): string {
	const ref = resolveBugHunterCompareRef(task, project);
	const branch = task.branchName || "HEAD";
	const prefix = agents.skillInvocationPrefix(baseCmd);
	return (
		`${prefix}dev3-bug-hunter ` +
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
	splitArgs: string[];
}): Promise<{ paneId: string | null; baseCmd: string }> {
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
	let launchedAgentId = opts.agentId;
	let launchedConfigId = opts.configId;
	if (opts.agentId) {
		const resolved = await agents.resolveCommandForAgent(opts.agentId, opts.configId, ctx, cmdOptions);
		tmuxCmd = resolved.command;
		extraEnv = resolved.extraEnv;
		resolvedBaseCmd = resolved.config?.baseCommandOverride || resolved.agent?.baseCommand || "";
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
		launchedAgentId = resolved.agent?.id ?? null;
		launchedConfigId = resolved.config?.id ?? null;
	}

	// Same trust/config-ensure the primary launch does — a Codex bug-hunter pane
	// otherwise launches against a stale config.toml and crashes.
	await ensureAgentTrust(opts.worktreePath, opts.project.path, resolvedBaseCmd, opts.accountId);
	tmuxCmd = await applyAgentHooksToCommand(opts.worktreePath, resolvedBaseCmd, tmuxCmd, {
		stopTarget: opts.project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
	});

	const env: Record<string, string> = {
		...buildAgentEnv(extraEnv, opts.task.id),
		...ensureArtifactTemplateEnv(opts.project, opts.task, opts.worktreePath),
	};
	const existingPorts = portPool.getPortAssignments(opts.task.id);
	if (existingPorts.length > 0) {
		Object.assign(env, portPool.buildPortEnv(existingPorts));
	}

	const scriptPath = `/tmp/dev3-${opts.task.id}-bughunt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`;
	await Bun.write(scriptPath, buildCmdScript(tmuxCmd, env));

	const proc = spawn(
		pty.tmuxArgs(opts.socket, "split-window", ...opts.splitArgs, "-P", "-F", "#{pane_id}", "-c", opts.worktreePath, `bash "${scriptPath}"`),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Failed to split pane: ${stderr.trim() || "unknown error"}`);
	}

	const newPaneId = stdout.trim() || null;

	const paneEntry = {
		paneId: newPaneId,
		agentCmd: resolvedBaseCmd,
		sessionId: agents.supportsPreAssignedSessionId(resolvedBaseCmd) ? freshSessionId : null,
		agentId: launchedAgentId,
		configId: launchedConfigId,
		accountId: opts.accountId,
	};
	try {
		const freshTask = await data.getTask(opts.project, opts.task.id);
		const existingPanes = freshTask.sessionState?.panes ?? [];
		const updated = await data.updateTask(opts.project, opts.task.id, {
			agentId: launchedAgentId,
			configId: launchedConfigId,
			sessionState: { panes: [...existingPanes, paneEntry] },
		});
		getPushMessage()?.("taskUpdated", { projectId: opts.project.id, task: updated });
	} catch (err) {
		log.error("Failed to append bug hunter pane to sessionState (non-fatal)", { error: String(err) });
	}

	return { paneId: newPaneId, baseCmd: resolvedBaseCmd };
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
	const tmuxSession = `dev3-${params.taskId.slice(0, 8)}`;

	const paneIds: string[] = [];

	// First hunter: split the current session horizontally, taking the right 50%.
	const first = await spawnSingleBugHunterPane({
		project,
		task,
		socket,
		tmuxSession,
		worktreePath: task.worktreePath,
		agentId: params.agentId,
		configId: params.configId,
		accountId: params.accountId,
		splitArgs: ["-h", "-l", "50%", "-t", tmuxSession],
	});
	if (first.paneId) paneIds.push(first.paneId);
	const resolvedBaseCmd = first.baseCmd;

	// Subsequent hunters: split the right column vertically. We compute -p per
	// split so all panes in the right column end up equal-sized WITHOUT calling
	// select-layout on the window (that command would also shrink the main left
	// pane to 1/N of the window, which broke the layout in the first iteration).
	// Formula: at split i (1-indexed, 1..N-1), the new pane should take
	// (N-i)/(N-i+1) of the target's current size. For N=3 → 67, 50. For N=6 →
	// 83, 80, 75, 67, 50.
	for (let i = 1; i < requestedCount; i++) {
		const target = paneIds[paneIds.length - 1] ?? first.paneId;
		if (!target) break;
		const remaining = requestedCount - i;
		const percent = Math.round((remaining / (remaining + 1)) * 100);
		try {
			const { paneId } = await spawnSingleBugHunterPane({
				project,
				task,
				socket,
				tmuxSession,
				worktreePath: task.worktreePath,
				agentId: params.agentId,
				configId: params.configId,
				accountId: params.accountId,
				splitArgs: ["-v", "-l", `${percent}%`, "-t", target],
			});
			if (paneId) paneIds.push(paneId);
		} catch (err) {
			log.warn("Bug hunter split failed (continuing with remaining)", { index: i, error: String(err) });
		}
	}

	// After the agents have had time to boot, paste the branch-scoped bug-hunter
	// slash command into each pane. The scope clause is mandatory: hunters must
	// only inspect files changed in this branch, never the whole codebase.
	//
	// Prompt paste and Enter are sent as TWO separate send-keys calls with a
	// delay — Claude Code's input layer can treat a fast send-keys "prompt Enter"
	// sequence as a single bracketed paste (where the trailing Enter becomes a
	// newline inside the paste, not a submit). Splitting them guarantees Enter
	// arrives as a discrete keypress after the paste buffer has been processed.
	const prompt = buildBugHunterPrompt(task, project, resolvedBaseCmd);
	for (const paneId of paneIds) {
		setTimeout(() => {
			try {
				const pasteProc = spawn(pty.tmuxArgs(socket, "send-keys", "-t", paneId, prompt), { stdout: "pipe", stderr: "pipe" });
				pasteProc.exited.catch(() => {});
			} catch (err) {
				log.warn("send-keys paste for bug hunter pane failed", { paneId, error: String(err) });
			}
			setTimeout(() => {
				try {
					const enterProc = spawn(pty.tmuxArgs(socket, "send-keys", "-t", paneId, "Enter"), { stdout: "pipe", stderr: "pipe" });
					enterProc.exited.catch(() => {});
				} catch (err) {
					log.warn("send-keys Enter for bug hunter pane failed", { paneId, error: String(err) });
				}
			}, BUG_HUNTER_ENTER_DELAY_MS);
		}, BUG_HUNTER_AUTOTYPE_DELAY_MS);
	}

	// Bump favorite usage — one per hunter actually spawned (all share the combo). Best-effort.
	void recordFavoriteUsages(
		Array.from({ length: paneIds.length }, () => ({ agentId: params.agentId, configId: params.configId })),
	);

	log.info("← spawnBugHuntersInTask done", { taskId: params.taskId.slice(0, 8), spawned: paneIds.length });
	return { spawned: paneIds.length };
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

		const socket = task.tmuxSocket ?? pty.DEFAULT_TMUX_SOCKET;
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

export const tmuxPtyHandlers = {
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
	killTmuxSession,
	tmuxAction,
	tmuxPaneCount,
	tmuxKillPane,
	tmuxPaneNavigate,
	tmuxLayout,
	tmuxWindowNavigate,
	tmuxAltClickMoveCursor,
	exitCopyModeAllPanes,
	spawnAgentInTask,
	spawnBugHuntersInTask,
	resumeTask,
	restartTask,
};
