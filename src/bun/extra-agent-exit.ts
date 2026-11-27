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
import { addressedAgentRefusal } from "./agent-message-target";
import { buildResumeCommand, getAllAgents } from "./agents";
import { AGENT_ACTOR } from "./board-operations/types";
import { boardPorts } from "./board-operations/runtime";
import * as taskNotes from "./board-operations/task-notes";
import * as data from "./data";
import {
	type AgentTurnEvent,
	type ExitBinding,
	type PendingExit,
	exitKey,
	lastTurn,
	pending,
	resetExtraAgentExitStateForTests,
} from "./extra-agent-exit-state";
import { createLogger } from "./logger";
import { sendPaneInput } from "./pane-input";
import { readPaneAgentIdentity } from "./scheduled-message-author";
import { taskTerminalBackendIdentity } from "./task-terminal-backend";

export type { AgentTurnEvent } from "./extra-agent-exit-state";

const log = createLogger("extra-agent-exit");

/** No Stop within this long after scheduling: the pane is closed without typing anything. */
export const EXTRA_AGENT_EXIT_DEADLINE_MS = 300_000;
/** Lets the Stop hook process itself finish before its pane is typed into. */
export const EXTRA_AGENT_EXIT_SETTLE_MS = 1_000;

type ExitTrigger = "turn-ended" | "idle" | "deadline";

const MAX_TRACKED_PANES = 500;

/**
 * What a pane's agent last reported; fed by the same hooks that move the card. A report
 * from another conversation than the one recorded for the pane is not this agent's turn.
 */
export function recordAgentTurnEvent(task: Task, paneId: string, event: AgentTurnEvent, sessionId: string | null): void {
	const recorded = task.sessionState?.panes?.find((pane) => pane.paneId === paneId)?.sessionId;
	if (recorded && sessionId && recorded !== sessionId) {
		log.debug("turn report from another conversation ignored", { taskId: task.id.slice(0, 8), paneId, event });
		return;
	}
	const key = exitKey(task.id, paneId);
	lastTurn.delete(key);
	lastTurn.set(key, { event, at: Date.now() });
	while (lastTurn.size > MAX_TRACKED_PANES) lastTurn.delete(lastTurn.keys().next().value!);
	const exit = pending.get(key);
	if (!exit) return;
	if (event === "Stop") {
		if (exit.phase === "waiting") armSettle(exit, EXTRA_AGENT_EXIT_SETTLE_MS);
	} else if (exit.phase === "settling") {
		if (exit.settleTimer) clearTimeout(exit.settleTimer);
		exit.settleTimer = null;
		exit.phase = "waiting";
	}
}

export function isExtraAgentExitScheduled(taskId: string, paneId: string): boolean {
	return pending.has(exitKey(taskId, paneId));
}

/** Who runs in the pane now, so a later exit can tell it is still the same agent. */
export async function captureExitBinding(task: Task, target: AgentExitTarget): Promise<ExitBinding> {
	const identity = await readPaneAgentIdentity(task, target.paneId, { generation: true }).catch(() => null);
	return { author: identity?.ok ? identity.author : null, sessionId: target.entry.sessionId, rootPid: target.rootPid };
}

/**
 * Why the exit no longer applies to the agent it was asked for, or null. `agentMayHaveLeft`:
 * the agent was asked to quit, so its absence is expected and only a pane taken over by
 * something else is a refusal.
 */
export async function exitBindingRefusal(task: Task, paneId: string, binding: ExitBinding, agentMayHaveLeft: boolean): Promise<string | null> {
	if (binding.author) return agentMayHaveLeft ? null : addressedAgentRefusal(task, binding.author, paneId);
	const target = (await resolveAgentExitTargets(task)).find((candidate) => candidate.paneId === paneId);
	if (!target) return agentMayHaveLeft ? null : `pane ${paneId} is gone`;
	if (binding.sessionId && target.entry.sessionId !== binding.sessionId) return `pane ${paneId} now holds another conversation`;
	if (binding.rootPid !== null && target.rootPid !== binding.rootPid) return `pane ${paneId} was restarted`;
	return null;
}

/**
 * Plan the exit. `self`: the caller is that agent, so its own turn is running and the
 * next Stop is its end — unless one already arrived after the request started (the turn
 * ended while a dialog was open). Another agent that is idle (its last report was a Stop)
 * is closed at once; a busy or unknown one waits for its next Stop, up to the deadline.
 */
export function scheduleExtraAgentExit(
	task: Task,
	paneId: string,
	opts: { self: boolean; binding: ExitBinding; requestedAt?: number },
): { scheduled: true; already: boolean } {
	const key = exitKey(task.id, paneId);
	if (pending.has(key)) return { scheduled: true, already: true };
	const exit: PendingExit = {
		projectId: task.projectId,
		taskId: task.id,
		paneId,
		self: opts.self,
		binding: opts.binding,
		requestedAt: opts.requestedAt ?? Date.now(),
		phase: "waiting",
		deadlineAt: Date.now() + EXTRA_AGENT_EXIT_DEADLINE_MS,
		deadlineTimer: setTimeout(() => onDeadline(exit), EXTRA_AGENT_EXIT_DEADLINE_MS),
		settleTimer: null,
	};
	pending.set(key, exit);
	log.info("extra agent exit scheduled", { taskId: task.id.slice(0, 8), paneId, self: opts.self });
	const report = lastTurn.get(key);
	if (opts.self) {
		if (report?.event === "Stop" && report.at > exit.requestedAt) armSettle(exit, 0);
	} else if (report?.event === "Stop") {
		begin(exit, "idle");
	}
	return { scheduled: true, already: false };
}

const lastEventIsPrompt = (exit: PendingExit) => lastTurn.get(exitKey(exit.taskId, exit.paneId))?.event === "UserPromptSubmit";

/** A turn ended: type after a short settle, unless a new prompt arrives first. */
function armSettle(exit: PendingExit, delayMs: number): void {
	exit.phase = "settling";
	const fire = () => {
		exit.settleTimer = null;
		if (exit.phase !== "settling") return;
		if (lastEventIsPrompt(exit)) exit.phase = "waiting";
		else begin(exit, "turn-ended");
	};
	if (delayMs > 0) exit.settleTimer = setTimeout(fire, delayMs);
	else fire();
}

function onDeadline(exit: PendingExit): void {
	if (exit.phase !== "running") begin(exit, "deadline");
}

function begin(exit: PendingExit, trigger: ExitTrigger): void {
	if (exit.phase === "running") return;
	exit.phase = "running";
	if (exit.settleTimer) clearTimeout(exit.settleTimer);
	exit.settleTimer = null;
	if (trigger === "deadline") clearTimeout(exit.deadlineTimer);
	void runExit(exit, trigger).then((outcome) => {
		if (outcome === "finished") {
			pending.delete(exitKey(exit.taskId, exit.paneId));
			return;
		}
		// A new turn began before anything was typed: wait for its Stop, under the original deadline.
		exit.phase = "waiting";
		if (Date.now() >= exit.deadlineAt) begin(exit, "deadline");
	});
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

/** True when the agent left on request. */
async function waitForAgentToLeave(task: Task, target: AgentExitTarget): Promise<boolean> {
	const taskId = task.id.slice(0, 8);
	const waited = await waitForPanesToEmpty([target]);
	if (waited.kind === "timed-out") log.warn("the agent did not leave on request, closing the pane", { taskId, paneId: target.paneId, elapsedMs: waited.elapsedMs });
	return waited.kind === "exited";
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

const addNote = (project: Project, taskId: string, text: string) => taskNotes.addNote(boardPorts, project, taskId, text, AGENT_ACTOR);

/** Never throws: the caller is a timer, and every outcome is in the log. */
async function runExit(exit: PendingExit, trigger: ExitTrigger): Promise<"finished" | "wait-again"> {
	const taskId = exit.taskId.slice(0, 8);
	try {
		const project = await data.getProject(exit.projectId);
		const task = await data.getTask(project, exit.taskId);
		const target = (await resolveAgentExitTargets(task)).find((candidate) => candidate.paneId === exit.paneId);
		if (!target) {
			log.info("extra agent pane is already gone", { taskId, paneId: exit.paneId, trigger });
			return "finished";
		}
		// Read before anything is killed: the pane's entry leaves the task with it.
		const { entry } = target;
		const label = await extraAgentLabel(entry);
		const sessionId = entry.sessionId;
		const resume = sessionId ? buildResumeCommand(entry.agentCmd, sessionId, entry.agentFamily ?? undefined) : null;
		const dropped = async (reason: string) => {
			log.warn("extra agent exit dropped", { taskId, paneId: exit.paneId, trigger, reason });
			await addNote(project, exit.taskId, `Exit of extra agent ${label} in pane ${exit.paneId} was dropped: ${reason}`);
			return "finished" as const;
		};

		let agentMayHaveLeft = false;
		if (trigger === "deadline") {
			log.warn("no turn end within the deadline, closing the pane without typing", { taskId, paneId: exit.paneId });
		} else {
			const refusal = await exitBindingRefusal(task, exit.paneId, exit.binding, false);
			if (refusal) return await dropped(refusal);
			if (lastEventIsPrompt(exit)) return "wait-again";
			clearTimeout(exit.deadlineTimer);
			if (await typeExitCommand(task, target)) agentMayHaveLeft = await waitForAgentToLeave(task, target);
		}

		const refusal = await exitBindingRefusal(await data.getTask(project, exit.taskId), exit.paneId, exit.binding, agentMayHaveLeft);
		if (refusal) return await dropped(refusal);
		let failure: string | null = null;
		try {
			if (!(await closePane(project, exit.taskId, exit.paneId))) failure = "the pane is still open after the close request";
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
		if (failure) {
			log.warn("the extra agent pane could not be closed", { taskId, paneId: exit.paneId, failure });
			await addNote(project, exit.taskId, `Could not close extra agent ${label} in pane ${exit.paneId}: ${failure}. Close it by hand.`);
			return "finished";
		}
		await addNote(project, exit.taskId, describeClosure(label, exit.paneId, exit.self, sessionId, resume));
		log.info("extra agent closed", { taskId, paneId: exit.paneId, trigger, self: exit.self });
	} catch (error) {
		log.warn("extra agent exit failed", { taskId, paneId: exit.paneId, trigger, error: String(error) });
	}
	return "finished";
}

/** @internal Tests only. */
export function _resetExtraAgentExitForTests(): void {
	resetExtraAgentExitStateForTests();
}
