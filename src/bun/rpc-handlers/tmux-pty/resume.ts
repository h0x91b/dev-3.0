import type { AgentFamily, CodingAgent, PaneSessionEntry, Project, Task } from "../../../shared/types";
import * as data from "../../data";
import * as pty from "../../pty-server";
import * as agents from "../../agents";
import { codexAccountIdForHome } from "../../agent-accounts";
import { chooseTaskCodexConversations } from "../../codex-task-selection";
import { getAgentAdapter } from "../../../shared/agent-adapters/registry";
import { agentKey } from "../../../shared/agent-adapters/families";
import * as repoConfig from "../../repo-config";
import { resolveResumableSessionIds } from "../../agent-transcripts";
import { DEFAULT_TMUX_SOCKET, taskSessionName, tmux } from "../../tmux";
import { dev3TaskTempPath } from "../../temp-paths";
import { taskTerminalBackendIdentity } from "../../task-terminal-backend";
import { nativeTaskPanesAlive, stopNativeTaskPanes } from "../../native-task-panes";
import { assertTaskWorkspacePresent } from "../../task-workspace-guard";
import type { ResumePaneMode, ResumePaneReport, ResumeUnavailableReason, TaskResumeResult } from "../../../shared/agent-resume";
import { WAKE_SHELL_NOTICE } from "../../../shared/task-hibernate";
import { getPushMessage, buildCmdScript, log, writeLaunchScript } from "../shared-pure";
import { applyAgentHooksToCommand, ensureAgentTrust, launchTaskPty } from "./task-launch";
import { findTaskAcrossProjects, markTerminalAttached, wakeIfHibernated } from "./task-state";

/**
 * Resume pointers for every pane, healed against the transcripts on disk in one
 * pass so no two panes reopen the same conversation (decision 189, #1950).
 */
function resolveResumeTargets(task: Task, panes: readonly PaneSessionEntry[]): { sessionId: string | null; mode: ResumePaneMode }[] {
	const targets = resolveResumableSessionIds(task.worktreePath ?? "", panes.map((pane, i) => ({ ...pane, adoptsOrphan: i === 0 })));
	return targets.map((target, i) => {
		if (target.substituted || target.startFresh) {
			log.warn(target.startFresh
				? "Stored session id is not resumable and every transcript belongs to another pane — starting this pane on a new conversation"
				: "Stored session id is not resumable for this pane — resuming another conversation instead", {
				taskId: task.id.slice(0, 8),
				pane: i === 0 ? "main" : `pane ${i}`,
				stored: panes[i].sessionId,
				using: target.sessionId ?? (target.startFresh ? "fresh-session" : "agent-latest"),
			});
		}
		// `--continue` here would reopen another pane's conversation, so the pane
		// starts on a new one. An extra pane carrying nothing but a command string
		// cannot be launched that way and keeps the harness's own latest.
		const startsFresh = target.startFresh && (i === 0 || !!panes[i].agentId);
		const mode: ResumePaneMode = startsFresh ? "fresh-session"
			: !target.sessionId ? "agent-latest"
			: target.substituted ? "substituted"
			: target.verified ? "exact" : "unverified";
		return { sessionId: target.sessionId, mode };
	});
}

/** The stored panes, or — when there are none — the lost Codex conversation resumeTask would reopen. Never persisted here. */
export async function sessionStateOrLostCodexPane(project: Project | null, task: Task): Promise<Task["sessionState"] | null> {
	if (task.sessionState?.panes?.length) return task.sessionState;
	if (!project || !task.worktreePath) return null;
	try {
		const resolvedProject = project.kind === "virtual" ? project : await repoConfig.resolveProjectConfig(project, task.worktreePath);
		const lost = await lostCodexMainPane(resolvedProject, task);
		return lost ? { panes: [lost] } : null;
	} catch (err) {
		log.warn("Lost Codex conversation lookup failed (non-fatal)", { taskId: task.id.slice(0, 8), error: String(err) });
		return null;
	}
}

/**
 * A Codex task whose pane record was lost (pane-exit reconciliation emptied it)
 * may still have its conversation on disk. Rebuild the main pane around the one
 * the selection engine would resume; when the choice is unclear the pane keeps
 * no id, so resuming it shows why instead of guessing. Null when the task is not
 * Codex or nothing of this task was found.
 */
async function lostCodexMainPane(project: Project, task: Task): Promise<PaneSessionEntry | null> {
	if (!task.worktreePath || !task.agentId) return null;
	const agent = (await agents.getAllAgents()).find((entry) => entry.id === task.agentId);
	if (!agent) return null;
	const config = agents.findConfig(agent, task.configId);
	const baseCommand = config?.baseCommandOverride || agent.baseCommand;
	if (agentKey(baseCommand, agent.agentFamily) !== "codex") return null;
	const pane: PaneSessionEntry = {
		agentCmd: baseCommand,
		sessionId: null,
		agentId: task.agentId,
		configId: task.configId ?? null,
		...(agent.agentFamily ? { agentFamily: agent.agentFamily } : {}),
	};
	let sessionId: string | null = null;
	try {
		sessionId = (await chooseTaskCodexConversations(project, task, [pane], "explicit-resume", { persist: false })).get(0)?.sessionId ?? null;
	} catch (err) {
		// Something of this task exists but cannot be chosen: offer the resume so it explains itself.
		if (!/No Codex conversation of this task/.test(String(err))) return pane;
		return null;
	}
	if (!sessionId) return null;
	log.warn("Codex task has no pane record — resuming the newest conversation of its worktree", {
		taskId: task.id.slice(0, 8),
		sessionId,
	});
	return { ...pane, sessionId };
}

/** Same harness the relaunch resolves: the pane's agent record first, its own snapshot only without one. */
function paneHarnessCanResume(pane: PaneSessionEntry, allAgents: CodingAgent[]): boolean {
	const agent = pane.agentId ? allAgents.find((entry) => entry.id === pane.agentId) : undefined;
	if (!agent) return getAgentAdapter(pane.agentCmd, pane.agentFamily ?? undefined).supportsResume;
	const config = agents.findConfig(agent, pane.configId);
	return getAgentAdapter(config?.baseCommandOverride || agent.baseCommand, agent.agentFamily).supportsResume;
}

/** A resume asked to refuse rather than guess (`dev3 agent resume`) found nothing safe to reopen. Nothing was launched. */
export class ResumeUnavailableError extends Error {
	constructor(readonly reason: ResumeUnavailableReason, message: string, readonly panes?: ResumePaneReport[]) {
		super(message);
	}
}

export interface ResumeTaskOptions {
	/** Report a live terminal instead of tearing it down to relaunch. */
	refuseLive?: boolean;
	/** Refuse when any pane has no conversation id and would fall back to the harness's own latest. */
	requireSessionIds?: boolean;
	/** Refuse when any pane runs a harness that cannot resume and would start over from the description. */
	refuseFresh?: boolean;
}

export type ResumeTaskSessionOutcome =
	| { kind: "resumed"; url: string; result: TaskResumeResult }
	| { kind: "already-running"; backend: "tmux" | "native" };

const resumeFlights = new Map<string, Promise<ResumeTaskSessionOutcome>>();

/** The backend is the ground truth: this process may not hold a handle to a session that is alive. */
export async function taskTerminalAlive(task: Task): Promise<boolean> {
	return taskTerminalBackendIdentity(task) === "native"
		? nativeTaskPanesAlive(task.id)
		: pty.tmuxSessionExists(task.id, task.tmuxSocket ?? DEFAULT_TMUX_SOCKET);
}

const TEARDOWN_WAIT_MS = 5_000;
const TEARDOWN_POLL_MS = 100;

/**
 * End a task's terminal and wait until the backend agrees it is gone. A relaunch
 * racing a fire-and-forget `kill-session` attaches to the dying session
 * (`new-session -A`) instead of starting the agent. Callers confirm with `refuseLive`.
 */
export async function tearDownTaskTerminal(task: Task): Promise<void> {
	if (taskTerminalBackendIdentity(task) === "native") {
		if (pty.hasSession(task.id)) await pty.destroySessionAwaited(task.id);
		else await stopNativeTaskPanes(task.id);
		return;
	}
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	// Exactly one kill: a second one still in flight could land on the fresh session.
	if (pty.hasSession(task.id)) pty.destroySession(task.id, socket);
	else await tmux.killSession(taskSessionName(task.id), { socket, bestEffort: true });
	for (let waited = 0; waited < TEARDOWN_WAIT_MS && await pty.tmuxSessionExists(task.id, socket); waited += TEARDOWN_POLL_MS) {
		await new Promise((resolve) => setTimeout(resolve, TEARDOWN_POLL_MS));
	}
}

/**
 * The Resume Session path, shared by the terminal's button and `dev3 agent resume`.
 * One resume per task at a time: a second caller (a click while the CLI resumes,
 * a CLI retry) joins the first instead of tearing its fresh session down.
 */
export function resumeTaskSession(taskId: string, opts: ResumeTaskOptions = {}): Promise<ResumeTaskSessionOutcome> {
	const inFlight = resumeFlights.get(taskId);
	if (inFlight) return inFlight;
	const run = performTaskResume(taskId, opts).finally(() => resumeFlights.delete(taskId));
	resumeFlights.set(taskId, run);
	return run;
}

export async function resumeTask(params: { taskId: string }): Promise<string> {
	const outcome = await resumeTaskSession(params.taskId);
	return outcome.kind === "resumed" ? outcome.url : `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
}

async function performTaskResume(taskId: string, opts: ResumeTaskOptions): Promise<ResumeTaskSessionOutcome> {
	const params = { taskId };
	log.info("→ resumeTask", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot resume: task ${params.taskId} not found or has no worktree`);
	}
	if (opts.refuseLive && await taskTerminalAlive(task)) {
		return { kind: "already-running", backend: taskTerminalBackendIdentity(task) };
	}
	const woke = task.hibernated === true;
	const resolvedProject = project.kind === "virtual"
		? project
		: await repoConfig.resolveProjectConfig(project, task.worktreePath);
	const stored = task.sessionState?.panes ?? [];
	const lost = stored.length ? null : await lostCodexMainPane(resolvedProject, task);
	const panes = lost ? [lost] : [...stored];
	if (!panes.length) {
		throw new ResumeUnavailableError("no-saved-session", `Cannot resume: task ${params.taskId} has no stored pane sessions`);
	}
	if (lost) task.sessionState = { panes };
	// Every Codex pane is chosen from one snapshot and claimed before anything
	// launches; a pane that cannot be chosen safely refuses the whole resume.
	const codexChoices = await chooseTaskCodexConversations(resolvedProject, task, panes, "explicit-resume", { persist: true, onDisk: stored });
	const codexHomes = new Map<number, string>();
	for (const [index, choice] of codexChoices) {
		panes[index] = { ...panes[index], sessionId: choice.sessionId };
		codexHomes.set(index, choice.codexHome);
	}
	// launchTaskPty rewrites pane[0] and copies the rest from here, so it must
	// carry the claimed ids, not the snapshot's.
	if (codexChoices.size) task.sessionState = { panes };
	const allAgents = await agents.getAllAgents();
	const targets = resolveResumeTargets(task, panes).map((target, i) => {
		// The launch is unchanged; only the report admits that this harness starts over.
		if (!paneHarnessCanResume(panes[i], allAgents)) return { ...target, mode: "fresh" as const };
		// The selection engine chose a Codex id from the transcripts it read.
		return codexChoices.has(i) && target.sessionId ? { ...target, mode: "exact" as const } : target;
	});
	const reports: ResumePaneReport[] = panes.map((pane, i) => ({
		index: i,
		agentId: pane.agentId,
		configId: pane.configId,
		accountId: pane.accountId ?? null,
		agentFamily: pane.agentFamily ?? null,
		storedSessionId: stored[i]?.sessionId ?? null,
		sessionId: targets[i].mode === "fresh" ? null : targets[i].sessionId,
		mode: targets[i].mode,
		status: "skipped",
		paneId: null,
	}));
	if (opts.refuseFresh && targets.some((target) => target.mode === "fresh")) {
		throw new ResumeUnavailableError(
			"harness-cannot-resume",
			"A saved pane runs an agent CLI dev3 cannot resume, so it would start over from the task description. Use Resume Session or Start Fresh in the app if that is what you want.",
			reports,
		);
	}
	if (opts.requireSessionIds && targets.some((target) => target.mode === "agent-latest")) {
		throw new ResumeUnavailableError(
			"session-id-unknown",
			"No conversation id is known for every saved pane, so the harness would pick its own latest and may start a new conversation.",
			reports,
		);
	}
	await wakeIfHibernated(project, task);

	// Destroy any dead session in memory
	if (pty.hasSession(params.taskId)) {
		await pty.destroySessionAwaited(params.taskId);
	}

	// Launch main pane (panes[0]) with resume
	const main = panes[0];
	const mainResume = targets[0].sessionId;
	const mainFreshSessionId = targets[0].mode === "fresh-session" ? crypto.randomUUID() : undefined;
	await launchTaskPty(
		resolvedProject,
		task,
		task.worktreePath,
		main.agentId,
		main.configId,
		false,
		true,
		{ sessionId: mainResume ?? undefined, accountId: main.accountId, codexHome: codexHomes.get(0), freshSessionId: mainFreshSessionId },
	);
	reports[0].status = "resumed";
	if (mainFreshSessionId) reports[0].sessionId = mainFreshSessionId;
	const backend = taskTerminalBackendIdentity(task);
	if (panes.length > 1 && backend !== "tmux") {
		for (const report of reports.slice(1)) report.detail = "The native terminal backend restores only the main pane; this one stays saved.";
	}

	// Resume extra panes (panes[1..]) via split-window.
	// Wait for the tmux session to be ready before splitting.
	if (panes.length > 1 && backend === "tmux") {
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
			for (const report of reports.slice(1)) report.detail = "The tmux session was not ready in time; this pane stays saved.";
		} else {
			const ctx: agents.TemplateContext = {
				taskTitle: task.title,
				taskDescription: "",
				projectName: project.name,
				projectPath: project.path,
				worktreePath: task.worktreePath,
			};
			const paneIdUpdates: Array<{ index: number; paneId: string; accountId: string | null | undefined; sessionId: string | null }> = [];
			for (let i = 1; i < panes.length; i++) {
				const pane = panes[i];
				try {
					const paneResume = targets[i].sessionId;
					const codexHome = codexHomes.get(i);
					const accountId = codexHome ? codexAccountIdForHome(codexHome) ?? null : pane.accountId;
					// Every conversation of this worktree belongs to another pane, so
					// `--continue` would open one of theirs: start this pane over instead.
					const freshSessionId = targets[i].mode === "fresh-session" ? crypto.randomUUID() : null;
					const cmdOpts: agents.CommandOptions = freshSessionId
						? { sessionId: freshSessionId, accountId }
						: { resume: true, accountId };
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
					if (codexHome) extraEnv.CODEX_HOME = codexHome;
					// The pane inherits the session's project env, so trust follows its CLAUDE_CONFIG_DIR too.
					const paneEnv = {
						...(await repoConfig.resolveProjectEnv(resolvedProject, task.worktreePath, { foreignCode: task.foreignCode })),
						...extraEnv,
					};
					await ensureAgentTrust(task.worktreePath, project.path, resumeBaseCmd, accountId, task.foreignCode, resumeAgentFamily, paneEnv);
					resumeCmd = await applyAgentHooksToCommand(task.worktreePath, resumeBaseCmd, resumeCmd, {
						stopTarget: project.autoReviewEnabled ? "review-by-ai" : "review-by-user",
						family: resumeAgentFamily,
					});
					const scriptPath = dev3TaskTempPath(params.taskId, `resume-pane-${i}.sh`);
					await writeLaunchScript(scriptPath, buildCmdScript(resumeCmd, extraEnv, { keepShell: true }));
					const wrappedCmd = `bash "${scriptPath}"`;
					const newPaneId = await pty.splitAndRunCommand(params.taskId, socket, wrappedCmd, task.worktreePath);
					if (newPaneId) paneIdUpdates.push({ index: i, paneId: newPaneId, accountId, sessionId: freshSessionId ?? paneResume });
					reports[i] = { ...reports[i], status: "resumed", paneId: newPaneId ?? null, accountId: accountId ?? null, sessionId: freshSessionId ?? paneResume };
					log.info("Resumed extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, paneId: newPaneId, command: resumeCmd.slice(0, 100) });
				} catch (err) {
					log.warn("Failed to resume extra pane", { taskId: params.taskId.slice(0, 8), paneIndex: i, error: String(err) });
					reports[i] = { ...reports[i], status: "failed", detail: String(err) };
				}
			}
			// Update pane IDs (they change across tmux server restarts) and the ids each pane resumed
			if (paneIdUpdates.length > 0) {
				try {
					const freshTask = await data.getTask(project, params.taskId);
					const updatedPanes = [...(freshTask.sessionState?.panes ?? [])];
					for (const { index, paneId, accountId, sessionId } of paneIdUpdates) {
						const prior = updatedPanes[index];
						if (!prior) continue;
						// `--continue` names no id, so the stored one stays. A replaced id was found
						// in this worktree's own store, so the origin goes with the old one.
						const resumed = sessionId ?? prior.sessionId;
						const originCwd = resumed === prior.sessionId ? prior.sessionOriginCwd : undefined;
						updatedPanes[index] = { ...prior, paneId, accountId, sessionId: resumed, sessionOriginCwd: originCwd, parked: undefined };
					}
					await data.updateTask(project, params.taskId, { sessionState: { panes: updatedPanes } });
				} catch (err) {
					log.warn("Failed to update pane IDs after resume (non-fatal)", { error: String(err) });
				}
			}
		}
	}

	await markTerminalAttached(project, task);

	try {
		const mainPaneId = (await data.getTask(project, params.taskId)).sessionState?.panes?.[0]?.paneId ?? null;
		reports[0] = { ...reports[0], paneId: mainPaneId };
	} catch (err) {
		log.warn("Could not read the main pane id after resume (non-fatal)", { error: String(err) });
	}
	getPushMessage()?.("taskTerminalResumed", { taskId: params.taskId, projectId: project.id });

	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← resumeTask", { url });
	const socket = task.tmuxSocket ?? DEFAULT_TMUX_SOCKET;
	return {
		kind: "resumed",
		url,
		result: {
			taskId: task.id,
			seq: task.seq,
			projectId: project.id,
			backend,
			...(backend === "tmux" ? { tmux: { socket, session: taskSessionName(task.id) } } : {}),
			woke,
			panes: reports,
		},
	};
}

export async function restartTask(params: { taskId: string }): Promise<string> {
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

	// Clear old session state — a new one will be generated by launchTaskPty.
	// The abandoned conversation stays on disk; the floor keeps a scan off it.
	await data.updateTask(project, task.id, { sessionState: null, codexScanFloorAt: new Date().toISOString() });

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

/**
 * The wake screen's "plain shell": the task's terminal comes back with a shell
 * and no agent. Unlike {@link restartTask} it neither re-runs the brief nor
 * clears `sessionState`, so every saved pane can still be resumed later.
 */
export async function wakeTaskShell(params: { taskId: string }): Promise<string> {
	log.info("→ wakeTaskShell", { taskId: params.taskId.slice(0, 8) });
	const { task, project } = await findTaskAcrossProjects(params.taskId);
	if (!task || !project || !task.worktreePath) {
		throw new Error(`Cannot wake: task ${params.taskId} not found or has no worktree`);
	}
	if (!task.hibernated) throw new Error(`Cannot wake: task ${params.taskId} is not hibernated`);
	// Before the flag clears: a launch that then throws would strand the task awake with no terminal.
	assertTaskWorkspacePresent(project, task.worktreePath, task);
	await wakeIfHibernated(project, task);
	if (pty.hasSession(params.taskId)) {
		await pty.destroySessionAwaited(params.taskId);
	}
	const resolvedProject = project.kind === "virtual"
		? project
		: await repoConfig.resolveProjectConfig(project, task.worktreePath);
	await launchTaskPty(resolvedProject, task, task.worktreePath, null, null, false, false, { shellNotice: WAKE_SHELL_NOTICE });
	await markTerminalAttached(project, task);
	getPushMessage()?.("taskTerminalResumed", { taskId: params.taskId, projectId: project.id });
	const url = `ws://localhost:${pty.getPtyPort()}?session=${params.taskId}`;
	log.info("← wakeTaskShell", { url });
	return url;
}
