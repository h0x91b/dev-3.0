import type { Project, Task } from "../shared/types";
import type { PrWatch } from "../shared/pr-watch";
import { prStatusSubject, wrapPrStatusMessage } from "../shared/agent-message-envelope";
import * as data from "./data";
import * as git from "./git";
import { getPushMessage, log } from "./rpc-handlers/shared-pure";
import { applyPrWatchOutcome, evaluatePrWatches, upsertPrWatch, type PrWatchOutcome, type PrWatchSample } from "./pr-watch";

/** After a failed delivery the task is left alone this long, so a dead pane adds no log rows. */
export const PR_WATCH_RETRY_BACKOFF_MS = 5 * 60_000;

const retryAfter = new Map<string, number>();
// Two overlapping polls of one task (timer tick, popover refresh) must not both deliver.
const inFlight = new Set<string>();

export function _resetPrWatchRunnerState(): void {
	retryAfter.clear();
	inFlight.clear();
}

function isTerminal(task: Task): boolean {
	return task.status === "completed" || task.status === "cancelled";
}

/** Can the agent be typed into right now? Not while it waits on a question, sleeps, or has no pane. */
function agentCanReceive(task: Task): boolean {
	return !task.hibernated && task.status !== "user-questions" && (task.sessionState?.panes?.length ?? 0) > 0;
}

async function persistWatches(project: Project, taskId: string, change: (current: PrWatch[], task: Task) => PrWatch[]): Promise<Task> {
	const { task } = await data.updateTaskWith<void>(project, taskId, (current) => {
		const next = change(current.prWatches ?? [], current);
		return { updates: { prWatches: next.length > 0 ? next : null }, result: undefined };
	});
	getPushMessage()?.("taskUpdated", { projectId: project.id, task });
	return task;
}

export async function addPrWatch(project: Project, taskId: string, watch: PrWatch): Promise<Task> {
	return persistWatches(project, taskId, (current, task) => {
		// The task may have ended while the subscribe handler waited on gh and ps.
		if (isTerminal(task)) throw new Error("The task has finished; there is nothing left to watch for.");
		return upsertPrWatch(current, watch);
	});
}

/** Remove every watch of the task; returns how many there were. */
export async function clearPrWatches(project: Project, taskId: string): Promise<number> {
	let count = 0;
	await persistWatches(project, taskId, (current) => {
		count = current.length;
		return [];
	});
	return count;
}

/**
 * Judge the task's watches against a freshly polled PR and, when some fire, type
 * one message per subscribing agent into its pane. Nothing is removed until the
 * message was accepted: an agent that cannot be reached keeps its watch and hears
 * about it on a later poll.
 */
export async function runPrWatches(project: Project, taskId: string, sample: PrWatchSample, prUrl: string): Promise<void> {
	if (inFlight.has(taskId)) return;
	inFlight.add(taskId);
	try {
		await runPrWatchesOnce(project, taskId, sample, prUrl);
	} finally {
		inFlight.delete(taskId);
	}
}

async function runPrWatchesOnce(project: Project, taskId: string, sample: PrWatchSample, prUrl: string): Promise<void> {
	// Fresh read: the poll's task snapshot may predate a `--off` or a new subscription.
	const task = await data.getTask(project, taskId);
	const watches = task.prWatches ?? [];
	const worktree = task.worktreePath;
	if (watches.length === 0 || !worktree || isTerminal(task)) return;

	const branch = await git.getCurrentBranch(worktree);
	const outcome = await evaluatePrWatches(watches, sample, {
		tips: branch ? await git.getRemoteBranchTips(worktree, branch) : [],
		isAncestor: (ancestor, descendant) => git.isRefMergedInto(worktree, ancestor, descendant),
	});
	const firedIds = new Set(outcome.fired.map(({ watch }) => watch.id));
	const quietPatches = Object.fromEntries(Object.entries(outcome.patches).filter(([id]) => !firedIds.has(id)));
	if (Object.keys(quietPatches).length > 0) {
		await persistWatches(project, taskId, (current) => applyPrWatchOutcome(current, { removeIds: [], patches: quietPatches }));
	}
	if (outcome.fired.length === 0) return;
	if (!agentCanReceive(task)) return;
	await deliverFired(project, taskId, outcome, sample.number, prUrl);
}

/** The whole identity of the subscribing agent: a pane can host one agent after another. */
function subscriberKey(watch: PrWatch): string {
	const author = watch.author;
	return author ? JSON.stringify([author.paneId, author.sessionId, author.paneToken, author.agentProcess]) : "";
}

type Fired = PrWatchOutcome["fired"];

/**
 * Type one message per target pane. A subscriber's own pane when it still runs; else
 * the task's only live agent pane (likely the same agent, resumed). With zero, several
 * or unknown agent panes and no proof, the watch waits and retries: a sibling is never guessed.
 */
async function deliverFired(project: Project, taskId: string, outcome: PrWatchOutcome, prNumber: number, prUrl: string): Promise<void> {
	// Re-read right before typing: a `--off`, another run, or the agent's own state may have changed since.
	const task = await data.getTask(project, taskId);
	const worktree = task.worktreePath;
	if (isTerminal(task) || !worktree || !agentCanReceive(task)) return;
	const held = new Set((task.prWatches ?? []).map((watch) => watch.id));

	const subscribers = new Map<string, Fired>();
	for (const fired of outcome.fired.filter(({ watch }) => held.has(watch.id))) {
		const key = subscriberKey(fired.watch);
		subscribers.set(key, [...(subscribers.get(key) ?? []), fired]);
	}

	const byPane = new Map<string, { fired: Fired; keys: string[] }>();
	let liveAgents: string[] | null | undefined;
	for (const [key, fired] of subscribers) {
		const backoffKey = `${taskId}|${key}`;
		if ((retryAfter.get(backoffKey) ?? 0) > Date.now()) continue;
		const author = fired[0].watch.author;
		let paneId: string | undefined;
		if (author) {
			const { resolveScheduledMessageAuthorPane } = await import("./scheduled-message-author");
			const resolved = await resolveScheduledMessageAuthorPane(task, author);
			if (resolved.ok) paneId = resolved.paneId;
		}
		if (!paneId) {
			const { liveAgentPaneIds } = await import("./scheduled-message-author");
			liveAgents ??= await liveAgentPaneIds(task);
			if (liveAgents?.length === 1) paneId = liveAgents[0];
		}
		if (!paneId) {
			retryAfter.set(backoffKey, Date.now() + PR_WATCH_RETRY_BACKOFF_MS);
			log.warn("PR watch waits: no single live agent pane and the subscriber cannot be resolved", { taskId: taskId.slice(0, 8) });
			continue;
		}
		const entry = byPane.get(paneId) ?? { fired: [], keys: [] };
		byPane.set(paneId, { fired: [...entry.fired, ...fired], keys: [...entry.keys, key] });
	}

	for (const [paneId, { fired, keys }] of byPane) {
		// Re-read before every send: the one before it may have taken time, and `--off` or a
		// move to a question can land in between.
		const fresh = await data.getTask(project, taskId);
		if (isTerminal(fresh) || !fresh.worktreePath || !agentCanReceive(fresh)) return;
		const heldNow = new Set((fresh.prWatches ?? []).map((watch) => watch.id));
		const live = fired.filter(({ watch }) => heldNow.has(watch.id));
		if (live.length === 0) continue;
		const ids = new Set(live.map(({ watch }) => watch.id));
		const settle = (current: PrWatch[]) => applyPrWatchOutcome(current, {
			removeIds: outcome.removeIds.filter((id) => ids.has(id)),
			patches: Object.fromEntries(Object.entries(outcome.patches).filter(([id]) => ids.has(id))),
		});
		const remaining = [...new Set(settle(fresh.prWatches ?? []).filter((watch) => keys.includes(subscriberKey(watch))).map((watch) => watch.until))];
		const notices = live.map(({ notice }) => notice);
		try {
			// Loaded on demand: the scheduler pulls in the whole prompt-delivery stack.
			const { sendMessageImmediately } = await import("./scheduled-message-scheduler");
			const text = wrapPrStatusMessage({ prNumber, url: prUrl, notices, remaining });
			await sendMessageImmediately(fresh, text, { kind: "pane", paneId }, null, { subject: prStatusSubject(prNumber, notices), origin: "dev3" });
		} catch (err) {
			for (const key of keys) retryAfter.set(`${taskId}|${key}`, Date.now() + PR_WATCH_RETRY_BACKOFF_MS);
			log.warn("PR watch message not delivered; the watch stays", { taskId: taskId.slice(0, 8), error: String(err) });
			return;
		}
		for (const key of keys) retryAfter.delete(`${taskId}|${key}`);
		await persistWatches(project, taskId, settle);
	}
}
