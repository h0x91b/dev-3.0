import type { AgentMessageSource, LaunchAfter, LaunchAfterUntil, LaunchVariant, Project, Task } from "../shared/types";
import * as data from "./data";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("launch-after");

/** A completed prerequisite whose merge is unknown is asked about at most this often. */
export const LAUNCH_AFTER_PROBE_INTERVAL_MS = 5 * 60_000;

export type LaunchAfterVerdict =
	| { kind: "wait" }
	| { kind: "fire" }
	| { kind: "abandon"; reason: string }
	/** Completed prerequisite, PR state never seen as merged: ask GitHub once. */
	| { kind: "probe"; prNumber: number };

function isPrMerged(task: Task): boolean {
	const cache = task.prStatusCache;
	if (cache?.mergeState?.state === "MERGED" && (task.prNumber == null || cache.number === task.prNumber)) return true;
	return (task.pullRequests ?? []).some((pr) => pr.state === "MERGED" && (task.prNumber == null || pr.number === task.prNumber));
}

/**
 * Decide what one waiting task does on this tick. Reads only what is already on
 * the prerequisite record: the PR poller keeps `prStatusCache` fresh while it runs.
 */
export function evaluateLaunchAfter(cond: LaunchAfter, prereq: Task | undefined): LaunchAfterVerdict {
	const ref = `#${cond.seq}`;
	if (!prereq) return { kind: "abandon", reason: `Waited for task ${ref}, which no longer exists` };
	if (prereq.status === "cancelled") return { kind: "abandon", reason: `Waited for task ${ref}, which was cancelled` };
	if (cond.until === "completed") return prereq.status === "completed" ? { kind: "fire" } : { kind: "wait" };
	if (isPrMerged(prereq)) return { kind: "fire" };
	if (prereq.status !== "completed") return { kind: "wait" };
	if (prereq.prNumber == null) return { kind: "abandon", reason: `Waited for the PR of task ${ref}, which was completed without one` };
	return { kind: "probe", prNumber: prereq.prNumber };
}

/** Why `task` cannot wait on `prereq`, or null when it can. `tasks` is the whole board. */
export function launchAfterRefusal(task: Task, prereq: Task, until: LaunchAfterUntil, tasks: Task[]): string | null {
	if (task.status !== "todo") return `Only a To Do task can wait to start (this one is ${task.status}).`;
	if (task.draft === true) return "A draft cannot wait to start: finish the draft first.";
	if (task.scheduledLaunch) return "This task already has a \"Start in\" time. Cancel it first.";
	if (prereq.id === task.id) return "A task cannot wait for itself.";
	if (prereq.projectId !== task.projectId) return "The task to wait for must be on the same board.";
	if (prereq.status === "cancelled") return `Task #${prereq.seq} is cancelled, so it will never finish.`;
	if (until === "merged" && prereq.status === "completed" && prereq.prNumber == null && !isPrMerged(prereq)) {
		return `Task #${prereq.seq} was completed without a pull request, so there is no merge to wait for.`;
	}
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const seen = new Set<string>();
	for (let cur: Task | undefined = prereq; cur?.launchAfter && !seen.has(cur.id); cur = byId.get(cur.launchAfter.taskId)) {
		seen.add(cur.id);
		if (cur.launchAfter.taskId === task.id) {
			return `Task #${prereq.seq} already waits, directly or through other tasks, for this one. That would never start.`;
		}
	}
	return null;
}

export function buildLaunchAfter(prereq: Task, until: LaunchAfterUntil, variant: LaunchVariant | null, armedBy: AgentMessageSource | null): LaunchAfter {
	return {
		taskId: prereq.id,
		seq: prereq.seq,
		until,
		...(variant ? { variant } : {}),
		...(armedBy ? { armedBy } : {}),
		armedAt: new Date().toISOString(),
	};
}

const lastProbe = new Map<string, number>();

// Lazy: both reach the Electrobun-backed handler graph, which the scheduler must not load at import.
async function lightAttention(taskId: string, projectId: string, reason: string): Promise<void> {
	const { pushCliAttention } = await import("./rpc-handlers/shared");
	pushCliAttention({ taskId, projectId, reason });
}

export function _resetLaunchAfterState(): void {
	lastProbe.clear();
}

async function pushUpdated(project: Project, task: Task): Promise<void> {
	getPushMessage()?.("taskUpdated", { projectId: project.id, task });
}

/** Clear the condition only if it is still the one this tick read: a re-arm in between wins. */
async function claim(project: Project, task: Task, cond: LaunchAfter, extra: Partial<Task> = {}): Promise<boolean> {
	const { task: updated, result } = await data.updateTaskWith(project, task.id, (cur) => {
		const same = cur.launchAfter?.taskId === cond.taskId && cur.launchAfter.armedAt === cond.armedAt;
		return same ? { updates: { launchAfter: null, ...extra }, result: true } : { updates: {}, result: false };
	});
	if (result) await pushUpdated(project, updated);
	return result;
}

async function abandon(project: Project, task: Task, cond: LaunchAfter, reason: string): Promise<void> {
	// The card prefixes `preparationError` with "Launch failed:", so it holds the cause alone.
	if (!await claim(project, task, cond, { preparationError: reason })) return;
	log.info("Start-after abandoned", { taskId: task.id.slice(0, 8), prerequisite: cond.taskId.slice(0, 8), reason });
	await lightAttention(task.id, project.id, `Did not start: ${reason}`);
}

async function recordFailure(project: Project, task: Task, err: unknown): Promise<void> {
	const reason = err instanceof Error ? err.message : String(err);
	log.error("Start-after launch failed", { taskId: task.id.slice(0, 8), error: String(err) });
	try {
		await pushUpdated(project, await data.updateTask(project, task.id, { preparationError: reason }));
	} catch {
		// the task may already be gone; the log row is all that is left to give
	}
	await lightAttention(task.id, project.id, `Start-after launch failed: ${reason}`);
}

/**
 * Launch a waiting task whose condition holds. The condition is cleared first,
 * under the tasks-file lock, so it fires exactly once. Armed by a person: the
 * same direct start as `dev3 task move --status in-progress` from a terminal.
 * Armed by an agent: the same approval dialog that agent's own move would get.
 */
async function fire(project: Project, task: Task, cond: LaunchAfter): Promise<void> {
	if (!await claim(project, task, cond)) return;
	log.info("Start-after fired", { taskId: task.id.slice(0, 8), prerequisite: cond.taskId.slice(0, 8), until: cond.until, byAgent: !!cond.armedBy });
	const { launchTaskWithAgentChoice, moveTask } = await import("./rpc-handlers/task-lifecycle");
	try {
		if (cond.armedBy) {
			const { requestAgentLaunchApproval } = await import("./cli-socket/approvals");
			const fresh = await data.getTask(project, task.id);
			// Not awaited: the dialog can stay open for minutes and the tick must not stall on it.
			void requestAgentLaunchApproval({
				project,
				task: fresh,
				targetStatus: "in-progress",
				requester: cond.armedBy,
				suggested: cond.variant ?? null,
			}).catch((err) => recordFailure(project, task, err));
		} else if (cond.variant) {
			await launchTaskWithAgentChoice({ taskId: task.id, projectId: project.id, targetStatus: "in-progress", choice: { variants: [cond.variant] } });
		} else {
			await moveTask({ taskId: task.id, projectId: project.id, newStatus: "in-progress", enforceAllowedTransition: true, explicitLaunch: true });
		}
	} catch (err) {
		await recordFailure(project, task, err);
	}
}

/** One scheduler tick over a project's tasks. Makes no network call unless a merge is unknown. */
export async function tickLaunchAfter(project: Project, tasks: Task[], now = Date.now()): Promise<void> {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	for (const task of tasks) {
		const cond = task.launchAfter;
		if (!cond) continue;
		try {
			// Started some other way: the condition has nothing left to start.
			if (task.status !== "todo") {
				await claim(project, task, cond);
				continue;
			}
			if (task.draft === true) continue;
			const verdict = evaluateLaunchAfter(cond, byId.get(cond.taskId));
			if (verdict.kind === "wait") continue;
			if (verdict.kind === "abandon") {
				await abandon(project, task, cond, verdict.reason);
				continue;
			}
			if (verdict.kind === "probe") {
				if (now - (lastProbe.get(task.id) ?? 0) < LAUNCH_AFTER_PROBE_INTERVAL_MS) continue;
				lastProbe.set(task.id, now);
				const { getPullRequestSnapshot } = await import("./github-pr-status");
				const snapshot = await getPullRequestSnapshot(project, project.path, verdict.prNumber);
				if (snapshot?.state === "MERGED") await fire(project, task, cond);
				else if (snapshot?.state === "CLOSED") await abandon(project, task, cond, `Waited for the PR of task #${cond.seq}, which was closed without merging`);
				continue;
			}
			lastProbe.delete(task.id);
			await fire(project, task, cond);
		} catch (err) {
			log.error("Start-after tick failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
}
