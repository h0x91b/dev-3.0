import type { AgentMessageSource, LaunchAfter, LaunchAfterUntil, LaunchVariant, Project, Task } from "../shared/types";
import { startAfterAbandonedMessage, type StartAfterAbandonReason } from "../shared/preparation-failure";
import * as data from "./data";
import { createLogger } from "./logger";
import { getPushMessage } from "./rpc-handlers/shared-pure";

const log = createLogger("launch-after");

/** A completed prerequisite whose merge is unknown is asked about at most this often. */
export const LAUNCH_AFTER_PROBE_INTERVAL_MS = 5 * 60_000;
/** GitHub probes in flight at once, across every board. Each one can take up to its 15 s deadline. */
export const LAUNCH_AFTER_PROBE_CONCURRENCY = 4;

export type LaunchAfterVerdict =
	| { kind: "wait" }
	| { kind: "fire" }
	| { kind: "abandon"; reason: StartAfterAbandonReason }
	/** Every variant is done and at least one completed with a PR whose merge was never seen: ask GitHub. */
	| { kind: "probe"; prNumbers: number[] };

/** The PR a task is tied to: the sticky number, else the poller's reading, else the newest record. */
export function prNumberOf(task: Task): number | null {
	if (task.prNumber != null) return task.prNumber;
	if (task.prStatusCache?.number != null) return task.prStatusCache.number;
	const records = task.pullRequests ?? [];
	return records.length ? records[records.length - 1]!.number : null;
}

function isPrMerged(task: Task): boolean {
	const cache = task.prStatusCache;
	if (cache?.mergeState?.state === "MERGED" && (task.prNumber == null || cache.number === task.prNumber)) return true;
	return (task.pullRequests ?? []).some((pr) => pr.state === "MERGED" && (task.prNumber == null || pr.number === task.prNumber));
}

/**
 * The tasks that count as the prerequisite: the armed task plus every variant of its group.
 * Variants share the source's seq, so a deleted source still finds its siblings by seq.
 */
export function prerequisiteMembers(cond: LaunchAfter, tasks: Task[]): Task[] {
	const source = tasks.find((t) => t.id === cond.taskId);
	const groupId = source?.groupId ?? null;
	if (source && groupId == null) return [source];
	return tasks.filter((t) => t.id === cond.taskId
		|| (groupId != null ? t.groupId === groupId : t.groupId != null && t.seq === cond.seq));
}

const isDone = (t: Task) => t.status === "completed" || t.status === "cancelled";

/**
 * Decide what one waiting task does on this tick. Reads only what is already on
 * the prerequisite records: the PR poller keeps `prStatusCache` fresh while it runs.
 * Any variant of the prerequisite can satisfy the wait; it is abandoned only when none can.
 */
export function evaluateLaunchAfter(cond: LaunchAfter, members: Task[]): LaunchAfterVerdict {
	if (members.length === 0) return { kind: "abandon", reason: "gone" };
	if (cond.until === "completed") {
		if (members.some((t) => t.status === "completed")) return { kind: "fire" };
		return members.every((t) => t.status === "cancelled") ? { kind: "abandon", reason: "cancelled" } : { kind: "wait" };
	}
	if (members.some(isPrMerged)) return { kind: "fire" };
	if (!members.every(isDone)) return { kind: "wait" };
	const completed = members.filter((t) => t.status === "completed");
	if (completed.length === 0) return { kind: "abandon", reason: "cancelled" };
	const prNumbers = [...new Set(completed.map(prNumberOf).filter((n): n is number => n != null))];
	return prNumbers.length ? { kind: "probe", prNumbers } : { kind: "abandon", reason: "no-pr" };
}

/** Why nothing could ever wait on `prereq` (it is already finished), or null. Needs no waiting task, so `task create` asks it before creating one. */
export function prerequisiteRefusal(prereq: Task, until: LaunchAfterUntil, tasks: Task[]): string | null {
	const group = prereq.groupId != null ? tasks.filter((t) => t.groupId === prereq.groupId) : [];
	const members = group.length ? group : [prereq];
	if (members.every((t) => t.status === "cancelled")) return `Task #${prereq.seq} is cancelled, so it will never finish.`;
	if (until === "merged" && members.some(isPrMerged)) return `Task #${prereq.seq}'s pull request is already merged: start this task now instead.`;
	if (until === "completed" ? members.some((t) => t.status === "completed") : members.every(isDone)) {
		return `Task #${prereq.seq} is already completed: start this task now instead.`;
	}
	return null;
}

/** Why `task` cannot wait on `prereq`, or null when it can. `tasks` is the whole board. */
export function launchAfterRefusal(task: Task, prereq: Task, until: LaunchAfterUntil, tasks: Task[]): string | null {
	if (task.status !== "todo") return `Only a To Do task can wait to start (this one is ${task.status}).`;
	if (task.draft === true) return "A draft cannot wait to start: finish the draft first.";
	if (task.scheduledLaunch) return "This task already has a \"Start in\" time. Cancel it first.";
	if (prereq.id === task.id) return "A task cannot wait for itself.";
	if (prereq.projectId !== task.projectId) return "The task to wait for must be on the same board.";
	const refusal = prerequisiteRefusal(prereq, until, tasks);
	if (refusal) return refusal;
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

/** Write the condition and clear any earlier "Did not start" reason. No refusal check: callers ran it. */
export async function writeLaunchAfter(project: Project, task: Task, prereq: Task, until: LaunchAfterUntil, variant: LaunchVariant | null, armedBy: AgentMessageSource | null): Promise<Task> {
	const updated = await data.updateTask(project, task.id, {
		launchAfter: buildLaunchAfter(prereq, until, variant, armedBy),
		preparationError: null,
	});
	await pushUpdated(project, updated);
	return updated;
}

/** Arm `task` to start after `prereq`, refusing what could never start. Shared by the CLI and the board. */
export async function armLaunchAfter(project: Project, task: Task, prereq: Task, until: LaunchAfterUntil, variant: LaunchVariant | null, armedBy: AgentMessageSource | null): Promise<Task> {
	const refusal = launchAfterRefusal(task, prereq, until, await data.loadTasks(project));
	if (refusal) throw new Error(refusal);
	return writeLaunchAfter(project, task, prereq, until, variant, armedBy);
}

export async function clearLaunchAfter(project: Project, task: Task): Promise<Task> {
	if (!task.launchAfter) return task;
	const updated = await data.updateTask(project, task.id, { launchAfter: null });
	await pushUpdated(project, updated);
	return updated;
}

/**
 * The card's "Start now": a person at the board starts the task at once with the
 * condition's agent, so it never goes through the approval dialog. Errors reach the caller.
 */
export async function startLaunchAfterNow(project: Project, task: Task): Promise<void> {
	const cond = task.launchAfter;
	if (!cond) throw new Error("This task has no start condition.");
	if (!await claim(project, task, cond)) throw new Error("This task is no longer waiting to start.");
	const { launchTaskWithAgentChoice, moveTask } = await loadLifecycle();
	if (cond.variant) {
		await launchTaskWithAgentChoice({ taskId: task.id, projectId: project.id, targetStatus: "in-progress", choice: { variants: [cond.variant] } });
	} else {
		await moveTask({ taskId: task.id, projectId: project.id, newStatus: "in-progress", enforceAllowedTransition: true, explicitLaunch: true });
	}
}

/** Last GitHub probe per waiting task, tied to the condition it was made for: a re-arm probes at once. */
const lastProbe = new Map<string, { armedAt: string; at: number }>();
/** Probes still running, by waiting task id. The tick never awaits them. */
const probesInFlight = new Map<string, Promise<void>>();
let probeSlots = LAUNCH_AFTER_PROBE_CONCURRENCY;
const probeQueue: Array<() => void> = [];

async function withProbeSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (probeSlots === 0) await new Promise<void>((resolve) => probeQueue.push(resolve));
	else probeSlots--;
	try {
		return await fn();
	} finally {
		const next = probeQueue.shift();
		if (next) next();
		else probeSlots++;
	}
}

/** One shared load per module, so a burst of probes that resolve together awaits one import. */
function lazy<T>(load: () => Promise<T>): () => Promise<T> {
	let loaded: Promise<T> | null = null;
	return () => (loaded ??= load());
}
// Lazy: these reach the Electrobun-backed handler graph, which the scheduler must not load at import.
const loadShared = lazy(() => import("./rpc-handlers/shared"));
const loadLifecycle = lazy(() => import("./rpc-handlers/task-lifecycle"));
const loadApprovals = lazy(() => import("./cli-socket/approvals"));
const loadTaskResolution = lazy(() => import("./cli-socket/task-resolution"));
const loadPrStatus = lazy(() => import("./github-pr-status"));

async function lightAttention(taskId: string, projectId: string, reason: string): Promise<void> {
	const { pushCliAttention } = await loadShared();
	pushCliAttention({ taskId, projectId, reason });
}

export function _resetLaunchAfterState(): void {
	lastProbe.clear();
	probesInFlight.clear();
	probeQueue.length = 0;
	probeSlots = LAUNCH_AFTER_PROBE_CONCURRENCY;
}

/** Resolves once every probe started so far has finished. For tests. */
export async function _settleLaunchAfterProbes(): Promise<void> {
	while (probesInFlight.size) await Promise.all([...probesInFlight.values()]);
}

async function pushUpdated(project: Project, task: Task): Promise<void> {
	getPushMessage()?.("taskUpdated", { projectId: project.id, task });
}

/**
 * Clear the condition only if it is still the one this tick read: a re-arm in between wins.
 * True only when the task is also still in To Do, so a task the user started by hand
 * after the read loses its stale condition and is not started a second time.
 */
async function claim(project: Project, task: Task, cond: LaunchAfter, extra: Partial<Task> = {}): Promise<boolean> {
	const { task: updated, result } = await data.updateTaskWith(project, task.id, (cur) => {
		const same = cur.launchAfter?.taskId === cond.taskId && cur.launchAfter.armedAt === cond.armedAt;
		if (!same) return { updates: {}, result: "other" as const };
		if (cur.status !== "todo") return { updates: { launchAfter: null }, result: "dropped" as const };
		return { updates: { launchAfter: null, ...extra }, result: "claimed" as const };
	});
	if (result === "other") return false;
	lastProbe.delete(task.id);
	await pushUpdated(project, updated);
	return result === "claimed";
}

async function abandon(project: Project, task: Task, cond: LaunchAfter, reason: StartAfterAbandonReason): Promise<void> {
	const message = startAfterAbandonedMessage(reason, cond.seq);
	if (!await claim(project, task, cond, { preparationError: message })) return;
	log.info("Start-after abandoned", { taskId: task.id.slice(0, 8), prerequisite: cond.taskId.slice(0, 8), reason });
	await lightAttention(task.id, project.id, message);
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

/** Can the arming agent still take a report? A finished or deleted task cannot. */
async function requesterIsLive(armedBy: AgentMessageSource): Promise<boolean> {
	try {
		const { resolveTaskAcrossProjects } = await loadTaskResolution();
		const found = await resolveTaskAcrossProjects(armedBy.taskId);
		return !!found && !isDone(found.task);
	} catch {
		return false;
	}
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
	const { launchTaskWithAgentChoice, moveTask } = await loadLifecycle();
	try {
		if (cond.armedBy) {
			const { requestAgentLaunchApproval } = await loadApprovals();
			const fresh = await data.getTask(project, task.id);
			// The arming agent has usually finished by the time its condition holds; the new one must not report to it then.
			const handoff = await requesterIsLive(cond.armedBy);
			// Not awaited: the dialog can stay open for minutes and the tick must not stall on it.
			void requestAgentLaunchApproval({
				project,
				task: fresh,
				targetStatus: "in-progress",
				requester: cond.armedBy,
				suggested: cond.variant ?? null,
				handoff,
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

/** Ask GitHub about each candidate PR in parallel: any merge fires, all closed abandons, anything else keeps waiting. */
async function probe(project: Project, task: Task, cond: LaunchAfter, prNumbers: number[]): Promise<void> {
	const { getPullRequestSnapshot } = await loadPrStatus();
	const states = await Promise.all(prNumbers.map((n) => withProbeSlot(() => getPullRequestSnapshot(project, project.path, n))
		.then((s) => s?.state ?? null, () => null)));
	if (states.includes("MERGED")) await fire(project, task, cond);
	else if (states.every((s) => s === "CLOSED")) await abandon(project, task, cond, "pr-closed");
}

/** Start a probe off the tick's critical path, unless one already runs or the interval has not passed. */
function scheduleProbe(project: Project, task: Task, cond: LaunchAfter, prNumbers: number[], now: number): void {
	if (probesInFlight.has(task.id)) return;
	const last = lastProbe.get(task.id);
	if (last?.armedAt === cond.armedAt && now - last.at < LAUNCH_AFTER_PROBE_INTERVAL_MS) return;
	lastProbe.set(task.id, { armedAt: cond.armedAt, at: now });
	const run = probe(project, task, cond, prNumbers)
		.catch((err) => log.error("Start-after probe failed", { taskId: task.id.slice(0, 8), error: String(err) }))
		.finally(() => probesInFlight.delete(task.id));
	probesInFlight.set(task.id, run);
}

/**
 * One scheduler tick over a project's tasks. Makes no network call unless a merge is
 * unknown, and never waits on one: GitHub probes run in the background, a few at a time.
 */
export async function tickLaunchAfter(project: Project, tasks: Task[], now = Date.now()): Promise<void> {
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
			const verdict = evaluateLaunchAfter(cond, prerequisiteMembers(cond, tasks));
			if (verdict.kind === "wait") continue;
			if (verdict.kind === "abandon") await abandon(project, task, cond, verdict.reason);
			else if (verdict.kind === "probe") scheduleProbe(project, task, cond, verdict.prNumbers, now);
			else await fire(project, task, cond);
		} catch (err) {
			log.error("Start-after tick failed for task", { taskId: task.id.slice(0, 8), error: String(err) });
		}
	}
}
