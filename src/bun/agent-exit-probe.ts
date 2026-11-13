import type { Project, Task } from "../shared/types";
import { ACTIVE_STATUSES } from "../shared/types";
import * as data from "./data";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers";
import { type MainAgentLiveness, type ProcessTable, processTable, taskMainAgentLiveness } from "./scheduled-message-author";

const log = createLogger("agent-exit-probe");

const TICK_INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** What one probe pass does to a task's {@link Task.agentExitedAt}. */
export type AgentExitDecision = "mark" | "clear" | "keep";

/**
 * A task whose agent should be running in a live terminal: active, launched, not
 * parked, and not already known to have no terminal at all (`runtime: "idle"`).
 */
export function isAgentExitCandidate(task: Task): boolean {
	if (task.hibernated || task.draft || task.preparing || task.shuttingDown) return false;
	if (!task.worktreePath || !ACTIVE_STATUSES.includes(task.status)) return false;
	if (task.runtimeState?.runtime === "idle") return false;
	return (task.sessionState?.panes?.length ?? 0) > 0;
}

/**
 * The per-task decision. `exited` marks, `alive` clears, and `unknown` leaves the
 * flag alone — a guess never marks. A task that is no longer a candidate loses a
 * stale flag whatever the probe said.
 */
export function agentExitDecision(task: Task, liveness: MainAgentLiveness | null): AgentExitDecision {
	const flagged = !!task.agentExitedAt;
	if (!isAgentExitCandidate(task)) return flagged ? "clear" : "keep";
	if (liveness === "exited") return flagged ? "keep" : "mark";
	if (liveness === "alive") return flagged ? "clear" : "keep";
	return "keep";
}

/**
 * Keeps {@link Task.agentExitedAt} true to the process table: set when the main
 * agent exited and its pane shows only a shell, cleared once an agent runs again
 * or the task stops being a candidate. Runs beside the keep-alive watchdog.
 */
export function startAgentExitProbe(): void {
	if (timer) return;
	log.info("Agent exit probe started", { tickMs: TICK_INTERVAL_MS });
	void tick();
	timer = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopAgentExitProbe(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

async function tick(): Promise<void> {
	if (tickInFlight) return; // never overlap ticks
	// Liveness is `unknown` on Windows, and `unknown` never changes anything.
	if (process.platform === "win32") return;
	tickInFlight = true;
	try {
		let table: ProcessTable | undefined;
		const sharedTable = async () => (table ??= await processTable());
		const projects = [...await data.loadProjects(), ...await data.loadVirtualProjects()];
		for (const project of projects) {
			try {
				await tickProject(project, sharedTable);
			} catch (err) {
				log.error("Agent exit probe failed for project", { projectId: project.id, error: String(err) });
			}
		}
	} catch (err) {
		log.error("Agent exit probe failed", { error: String(err) });
	} finally {
		tickInFlight = false;
	}
}

async function tickProject(project: Project, sharedTable: () => Promise<ProcessTable>): Promise<void> {
	const tasks = await data.loadTasks(project);
	for (const task of tasks) {
		try {
			const liveness = isAgentExitCandidate(task) ? await taskMainAgentLiveness(task, await sharedTable()) : null;
			if (agentExitDecision(task, liveness) === "keep") continue;
			await applyDecision(project, task, liveness);
		} catch (err) {
			log.error("Agent exit check failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
}

/** Exported for unit tests — the locked write; it re-decides on the fresh task and its main pane. */
export async function applyDecision(project: Project, task: Task, liveness: MainAgentLiveness | null): Promise<void> {
	let wrote: AgentExitDecision = "keep";
	const { task: updated } = await data.updateTaskWith(project, task.id, (current) => {
		wrote = agentExitDecision(current, liveness);
		// A restart gives the main pane a new id: the verdict was about the old one.
		if (wrote === "mark" && current.sessionState?.panes?.[0]?.paneId !== task.sessionState?.panes?.[0]?.paneId) wrote = "keep";
		if (wrote === "mark") return { updates: { agentExitedAt: new Date().toISOString() }, result: null };
		if (wrote === "clear") return { updates: { agentExitedAt: undefined }, result: null };
		return { updates: {}, result: null };
	});
	if (wrote === "keep") return;
	log.info(wrote === "mark" ? "Agent exited; task marked" : "Agent exit mark cleared", { taskId: task.id.slice(0, 8) });
	getPushMessage()?.("taskUpdated", { projectId: project.id, task: updated });
}
