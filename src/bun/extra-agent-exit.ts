/**
 * Ends one extra agent's session on request, after its turn is over.
 *
 * `dev3 agent exit` runs INSIDE the agent's turn. Killing the pane at once would cut
 * the CLI call and the turn with it; typing `/exit` at once would land in a busy
 * agent. So the command only schedules the exit, and the Stop hook of that pane is
 * both the trigger and the proof that a prompt is there to type into. Nothing here
 * survives a restart: a forgotten schedule leaves a running agent, never a broken one.
 *
 * See `decisions/2026/11/27/extra-agent-exit-after-turn-end.md`.
 */

import { basename } from "node:path";
import { getAgentAdapter } from "../shared/agent-adapters";
import type { PaneSessionEntry, Project, Task } from "../shared/types";
import { agentPidsUnder, readAgentProcessEvidence, resolveAgentExitTargets, waitForPanesToEmpty, type AgentExitTarget } from "./agent-graceful-exit";
import { buildResumeCommand, getAllAgents } from "./agents";
import { AGENT_ACTOR } from "./board-operations/types";
import { boardPorts } from "./board-operations/runtime";
import * as taskNotes from "./board-operations/task-notes";
import * as data from "./data";
import { createLogger } from "./logger";
import { sendPaneInput } from "./pane-input";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";

const log = createLogger("extra-agent-exit");

/** No Stop within this long after scheduling: the pane is closed without typing anything. */
export const EXTRA_AGENT_EXIT_DEADLINE_MS = 300_000;
/** Lets the Stop hook process itself finish before its pane is typed into. */
export const EXTRA_AGENT_EXIT_SETTLE_MS = 1_000;
/** Without a process table (Windows) the agent's exit cannot be observed, so it is waited out. */
export const EXTRA_AGENT_EXIT_BLIND_WAIT_MS = 10_000;

export type AgentTurnEvent = "Stop" | "UserPromptSubmit";

type ExitTrigger = "turn-ended" | "idle" | "deadline";

interface PendingExit {
	projectId: string;
	taskId: string;
	paneId: string;
	self: boolean;
	started: boolean;
	deadlineTimer: ReturnType<typeof setTimeout>;
}

const MAX_TRACKED_PANES = 500;
const lastTurnEvent = new Map<string, AgentTurnEvent>();
const pending = new Map<string, PendingExit>();

const keyOf = (taskId: string, paneId: string) => `${taskId}:${paneId}`;

/** What a pane's agent last reported; fed by the same hooks that move the card. */
export function recordAgentTurnEvent(taskId: string, paneId: string, event: AgentTurnEvent): void {
	const key = keyOf(taskId, paneId);
	lastTurnEvent.delete(key);
	lastTurnEvent.set(key, event);
	while (lastTurnEvent.size > MAX_TRACKED_PANES) lastTurnEvent.delete(lastTurnEvent.keys().next().value!);
	const exit = pending.get(key);
	if (event === "Stop" && exit && !exit.started) start(exit, "turn-ended", EXTRA_AGENT_EXIT_SETTLE_MS);
}

export function isExtraAgentExitScheduled(taskId: string, paneId: string): boolean {
	return pending.has(keyOf(taskId, paneId));
}

/**
 * Plan the exit. `self`: the caller is that agent, so its own turn is running and the
 * next Stop is its end. Another agent that is idle (its last report was a Stop) is
 * closed at once; a busy or unknown one waits for its next Stop, up to the deadline.
 */
export function scheduleExtraAgentExit(task: Task, paneId: string, opts: { self: boolean }): { scheduled: true; already: boolean } {
	const key = keyOf(task.id, paneId);
	if (pending.has(key)) return { scheduled: true, already: true };
	const exit: PendingExit = {
		projectId: task.projectId,
		taskId: task.id,
		paneId,
		self: opts.self,
		started: false,
		deadlineTimer: setTimeout(() => start(exit, "deadline", 0), EXTRA_AGENT_EXIT_DEADLINE_MS),
	};
	pending.set(key, exit);
	log.info("extra agent exit scheduled", { taskId: task.id.slice(0, 8), paneId, self: opts.self });
	if (!opts.self && lastTurnEvent.get(key) === "Stop") start(exit, "idle", 0);
	return { scheduled: true, already: false };
}

function start(exit: PendingExit, trigger: ExitTrigger, delayMs: number): void {
	if (exit.started) return;
	exit.started = true;
	clearTimeout(exit.deadlineTimer);
	const run = () => void runExit(exit, trigger).finally(() => pending.delete(keyOf(exit.taskId, exit.paneId)));
	if (delayMs > 0) setTimeout(run, delayMs);
	else run();
}

/** The agent as the user knows it: its name and preset, else the command it runs. */
export async function extraAgentLabel(entry: Pick<PaneSessionEntry, "agentCmd" | "agentId" | "configId">): Promise<string> {
	try {
		const agent = (await getAllAgents()).find((candidate) => candidate.id === entry.agentId);
		if (agent) {
			const config = agent.configurations.find((candidate) => candidate.id === entry.configId);
			return config ? `${agent.name} / ${config.name}` : agent.name;
		}
	} catch (error) {
		log.warn("could not read the agent registry for a label", { error: String(error) });
	}
	return basename(entry.agentCmd);
}

async function typeExitCommand(task: Task, target: AgentExitTarget): Promise<boolean> {
	const { entry, paneId } = target;
	const program = getAgentAdapter(entry.agentCmd, entry.agentFamily ?? undefined).exitProgram();
	if (!program) {
		log.info("no quit command for this agent, closing the pane", { taskId: task.id.slice(0, 8), paneId, agentCmd: entry.agentCmd });
		return false;
	}
	const evidence = await readAgentProcessEvidence();
	// A pane whose agent already left holds a shell; a slash command typed there is a stray command.
	if (evidence && agentPidsUnder(target, evidence).length === 0) {
		log.info("the agent already left its pane, nothing to type", { taskId: task.id.slice(0, 8), paneId });
		return false;
	}
	try {
		const outcome = await sendPaneInput(task, paneId, program, { idPrefix: "extra-agent-exit" });
		if (outcome.status === "delivered" || outcome.status === "indeterminate") return true;
		log.warn("quit command not delivered", { taskId: task.id.slice(0, 8), paneId, status: outcome.status, reason: outcome.reason, detail: outcome.detail });
	} catch (error) {
		log.warn("quit command could not be sent", { taskId: task.id.slice(0, 8), paneId, error: String(error) });
	}
	return false;
}

async function waitForAgentToLeave(task: Task, target: AgentExitTarget): Promise<void> {
	const taskId = task.id.slice(0, 8);
	if (!(await readAgentProcessEvidence())) {
		await new Promise((resolve) => setTimeout(resolve, EXTRA_AGENT_EXIT_BLIND_WAIT_MS));
		return;
	}
	const waited = await waitForPanesToEmpty([target]);
	if (waited.kind === "timed-out") log.warn("the agent did not leave on request, closing the pane", { taskId, paneId: target.paneId, elapsedMs: waited.elapsedMs });
}

async function paneIsLive(project: Project, taskId: string, paneId: string): Promise<boolean> {
	const task = await data.getTask(project, taskId);
	return (await resolveAgentExitTargets(task)).some((candidate) => candidate.paneId === paneId);
}

/**
 * Backend-neutral close; true when the pane is gone afterwards. An agent that quit
 * often takes its pane with it, so absence is checked first and again after a failed
 * close; every other failure still throws.
 */
async function closePane(project: Project, taskId: string, paneId: string): Promise<boolean> {
	if (!(await paneIsLive(project, taskId, paneId))) {
		await reconcileClosedPane(project, taskId, paneId);
		return true;
	}
	const { taskPanesHandlers } = await import("./rpc-handlers/task-panes");
	try {
		const state = await taskPanesHandlers.taskPaneAction({ taskId, action: { kind: "close", paneId } });
		return !state.panes.some((pane) => pane.paneId === paneId);
	} catch (error) {
		if (await paneIsLive(project, taskId, paneId)) throw error;
		log.info("the pane left while it was being closed", { taskId: taskId.slice(0, 8), paneId });
		await reconcileClosedPane(project, taskId, paneId);
		return true;
	}
}

/** The kill path cleans sessionState only when it kills; a pane that died on its own is reconciled here. tmux only: native panes keep no registry entry. */
async function reconcileClosedPane(project: Project, taskId: string, paneId: string): Promise<void> {
	const task = await data.getTask(project, taskId);
	if (taskTerminalBackendIdentity(task) === "native") return;
	const { handlePaneExited } = await import("./rpc-handlers/tmux-pty/task-launch");
	await handlePaneExited(taskId, paneId);
}

function describeClosure(label: string, paneId: string, self: boolean, sessionId: string | null, resume: string | null): string {
	const who = self ? "self-exit" : "closed by another agent";
	return `Closed extra agent ${label} (pane ${paneId}, ${who}). Conversation: ${sessionId ?? "id unknown"}.${resume ? ` Resume: ${resume}` : ""}`;
}

/** Never throws: the caller is a timer, and every outcome is in the log. */
async function runExit(exit: PendingExit, trigger: ExitTrigger): Promise<void> {
	const taskId = exit.taskId.slice(0, 8);
	try {
		const project = await data.getProject(exit.projectId);
		const task = await data.getTask(project, exit.taskId);
		const target = (await resolveAgentExitTargets(task)).find((candidate) => candidate.paneId === exit.paneId);
		if (!target) {
			log.info("extra agent pane is already gone", { taskId, paneId: exit.paneId, trigger });
			return;
		}
		// Read before anything is killed: the pane's entry leaves the task with it.
		const { entry } = target;
		const label = await extraAgentLabel(entry);
		const sessionId = entry.sessionId;
		const resume = sessionId ? buildResumeCommand(entry.agentCmd, sessionId, entry.agentFamily ?? undefined) : null;

		if (trigger !== "deadline" && (await typeExitCommand(task, target))) await waitForAgentToLeave(task, target);
		else if (trigger === "deadline") log.warn("no turn end within the deadline, closing the pane without typing", { taskId, paneId: exit.paneId });

		if (!(await closePane(project, exit.taskId, exit.paneId))) {
			log.warn("the pane is still open after the close request", { taskId, paneId: exit.paneId });
			return;
		}
		await taskNotes.addNote(boardPorts, project, exit.taskId, describeClosure(label, exit.paneId, exit.self, sessionId, resume), AGENT_ACTOR);
		log.info("extra agent closed", { taskId, paneId: exit.paneId, trigger, self: exit.self });
	} catch (error) {
		log.warn("extra agent exit failed", { taskId, paneId: exit.paneId, trigger, error: String(error) });
	}
}

/** @internal Tests only. */
export function _resetExtraAgentExitForTests(): void {
	for (const exit of pending.values()) clearTimeout(exit.deadlineTimer);
	pending.clear();
	lastTurnEvent.clear();
}
