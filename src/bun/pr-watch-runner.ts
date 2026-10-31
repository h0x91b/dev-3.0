import { taskCompletesManually, type Project, type Task } from "../shared/types";
import { branchPrWatches, type PrWatch } from "../shared/pr-watch";
import { prStatusSubject, wrapPrStatusMessage } from "../shared/agent-message-envelope";
import { submissionMatchesTypedText } from "../shared/agent-terminal-prompt";
import * as data from "./data";
import * as git from "./git";
import { loadSettings } from "./settings";
import { getPushMessage, log } from "./rpc-handlers/shared-pure";
import { applyPrWatchOutcome, evaluatePrWatches, PINNED_PR_WATCH_GIT, upsertPrWatch, type PrWatchOutcome, type PrWatchSample } from "./pr-watch";

/** After a failed delivery the task is left alone this long, so a dead pane adds no log rows. */
export const PR_WATCH_RETRY_BACKOFF_MS = 5 * 60_000;

/** Longest hold on the merge-completion offer while a watch has not delivered yet (dead or stuck agent). */
export const MERGE_OFFER_WATCH_HOLD_MS = 10 * 60_000;
/** Cover left after the agent submitted the merged text: Codex and Copilot move the card to in-progress through a separate hook that may land later. */
export const MERGE_OFFER_SUBMITTED_GRACE_MS = 30_000;

const retryAfter = new Map<string, number>();
// taskId -> when dev3 stops holding the merge-completion offer for the watching agent; `noticeText` is set once the merged message was accepted.
const mergeOfferHolds = new Map<string, { until: number; noticeText?: string }>();
/** A run still going after this long is presumed hung: the next poll takes over instead of skipping forever. */
export const PR_WATCH_RUN_STALL_MS = 3 * 60_000;

// Two overlapping polls of one task and PR (timer tick, popover refresh) must not both deliver.
const inFlight = new Map<string, { startedAt: number }>();
// Tasks already warned about disagreeing remote refs; cleared when the refs agree again.
const ambiguousWarned = new Set<string>();

export function _resetPrWatchRunnerState(): void {
	retryAfter.clear();
	mergeOfferHolds.clear();
	inFlight.clear();
	ambiguousWarned.clear();
}

function isTerminal(task: Task): boolean {
	return task.status === "completed" || task.status === "cancelled";
}

/** Can the agent be typed into right now? Not while it waits on a question, sleeps, or has no pane. */
function agentCanReceive(task: Task): boolean {
	return !task.hibernated && task.status !== "user-questions" && (task.sessionState?.panes?.length ?? 0) > 0;
}

/** The agent's prompt-submit hook is the proof the merged text reached it; without a hook the 10-minute cap applies. */
export function releaseMergeOfferHoldOnSubmission(taskId: string, submitted: string): void {
	const hold = mergeOfferHolds.get(taskId);
	if (hold?.noticeText && submissionMatchesTypedText(submitted, hold.noticeText)) {
		mergeOfferHolds.set(taskId, { until: Date.now() + MERGE_OFFER_SUBMITTED_GRACE_MS });
	}
}

/** True while a hold entry exists for the task, expired or not. */
export function hasMergeOfferHold(taskId: string): boolean {
	return mergeOfferHolds.has(taskId);
}

/** True while a watching agent should handle the merge before dev3 offers the user task completion. */
export function mergeOfferHeld(task: Task, now = Date.now()): boolean {
	const hold = mergeOfferHolds.get(task.id);
	// A pinned PR is somebody else's: its merge says nothing about this task's completion.
	const hasWatches = branchPrWatches(task.prWatches).length > 0;
	if (hasWatches && agentCanReceive(task) && !hold) {
		mergeOfferHolds.set(task.id, { until: now + MERGE_OFFER_WATCH_HOLD_MS });
		return true;
	}
	if (!hasWatches && hold && hold.until <= now) mergeOfferHolds.delete(task.id);
	return (hold?.until ?? 0) > now;
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
	const task = await persistWatches(project, taskId, (current, task) => {
		// The task may have ended while the subscribe handler waited on gh and ps.
		if (isTerminal(task)) throw new Error("The task has finished; there is nothing left to watch for.");
		return upsertPrWatch(current, watch);
	});
	// A new subscription is a new merge cycle: an old hold must not block its offer.
	mergeOfferHolds.delete(taskId);
	return task;
}

/** Remove every watch of the task, or only those on PR `prNumber`; returns how many went. */
export async function clearPrWatches(project: Project, taskId: string, prNumber?: number): Promise<number> {
	let count = 0;
	await persistWatches(project, taskId, (current) => {
		const kept = prNumber === undefined ? [] : current.filter((watch) => watch.prNumber !== prNumber);
		count = current.length - kept.length;
		return kept;
	});
	return count;
}

/** The watches one run judges: the branch's own, or those pinned to `pinnedPr`. */
function watchesInScope(watches: readonly PrWatch[] | null | undefined, pinnedPr: number | undefined): PrWatch[] {
	if (pinnedPr === undefined) return branchPrWatches(watches);
	return (watches ?? []).filter((watch) => watch.pinned && watch.prNumber === pinnedPr);
}

/**
 * Judge the task's watches against a freshly polled PR and, when some fire, type
 * one message per subscribing agent into its pane. Nothing is removed until the
 * message was accepted: an agent that cannot be reached keeps its watch and hears
 * about it on a later poll. `pinnedPr` set: the sample is that pinned PR, read by number.
 */
export async function runPrWatches(
	project: Project, taskId: string, sample: PrWatchSample, prUrl: string, checkedAt: number, mergeCoversHead: boolean, pinnedPr?: number,
): Promise<void> {
	const runKey = `${taskId}|${pinnedPr ?? "branch"}`;
	const running = inFlight.get(runKey);
	if (running) {
		const pendingMs = Date.now() - running.startedAt;
		if (pendingMs < PR_WATCH_RUN_STALL_MS) return;
		log.error("PR watch run stalled; a new run takes over", { taskId: taskId.slice(0, 8), pendingMs });
	}
	const run = { startedAt: Date.now() };
	inFlight.set(runKey, run);
	try {
		await runPrWatchesOnce(project, taskId, sample, prUrl, checkedAt, mergeCoversHead, pinnedPr);
	} finally {
		if (inFlight.get(runKey) === run) inFlight.delete(runKey);
	}
}

async function runPrWatchesOnce(
	project: Project, taskId: string, sample: PrWatchSample, prUrl: string, checkedAt: number, mergeCoversHead: boolean, pinnedPr: number | undefined,
): Promise<void> {
	// Fresh read: the poll's task snapshot may predate a `--off` or a new subscription.
	const task = await data.getTask(project, taskId);
	const watches = watchesInScope(task.prWatches, pinnedPr);
	const worktree = task.worktreePath;
	if (watches.length === 0 || !worktree || isTerminal(task)) return;
	if (pinnedPr !== undefined && sample.number !== pinnedPr) return;

	const outcome = await evaluatePrWatches(watches, sample, pinnedPr === undefined ? await branchWatchGit(taskId, worktree) : PINNED_PR_WATCH_GIT, checkedAt);
	const firedIds = new Set(outcome.fired.map(({ watch }) => watch.id));
	const quietPatches = Object.fromEntries(Object.entries(outcome.patches).filter(([id]) => !firedIds.has(id)));
	if (Object.keys(quietPatches).length > 0) {
		await persistWatches(project, taskId, (current) => applyPrWatchOutcome(current, { removeIds: [], patches: quietPatches }));
	}
	const canReceive = agentCanReceive(task);
	log.info("PR watch evaluated", {
		taskId: taskId.slice(0, 8), pr: sample.number, ...(pinnedPr !== undefined ? { pinned: true } : {}), state: sample.state, watches: watches.length,
		fired: outcome.fired.length, ...(outcome.fired.length > 0 ? { agentCanReceive: canReceive } : {}),
	});
	if (outcome.fired.length === 0) return;
	if (!canReceive) return;
	await deliverFired(project, taskId, outcome, sample.number, prUrl, mergeCoversHead, pinnedPr);
}

/** The branch's remote tips, which decide whether a sampled head of its own PR is fresh. */
async function branchWatchGit(taskId: string, worktree: string): Promise<Parameters<typeof evaluatePrWatches>[2]> {
	const branch = await git.getCurrentBranch(worktree);
	const remote = branch ? await git.getRemoteBranchTips(worktree, branch) : { tips: [], ambiguous: false };
	if (!remote.ambiguous) ambiguousWarned.delete(taskId);
	else if (!ambiguousWarned.has(taskId)) {
		ambiguousWarned.add(taskId);
		log.warn("PR watch defers CI notices: same-named remote refs of the branch disagree", { taskId: taskId.slice(0, 8) });
	}
	// Cache hits retain their API timestamp and cannot count as a second CI observation.
	return {
		...remote,
		hasCommit: (sha) => git.commitExists(worktree, sha),
		isAncestor: (ancestor, descendant) => git.isRefMergedInto(worktree, ancestor, descendant),
	};
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
async function deliverFired(
	project: Project, taskId: string, outcome: PrWatchOutcome, prNumber: number, prUrl: string, mergeCoversHead: boolean, pinnedPr: number | undefined,
): Promise<void> {
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
		const backoffKey = `${taskId}|${pinnedPr ?? "branch"}|${key}`;
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
		const remaining = [...new Set(watchesInScope(settle(fresh.prWatches ?? []), pinnedPr).filter((watch) => keys.includes(subscriberKey(watch))).map((watch) => watch.until))];
		const notices = live.map(({ notice }) => notice);
		let text: string;
		try {
			// Loaded on demand: the scheduler pulls in the whole prompt-delivery stack.
			const { sendMessageImmediately } = await import("./scheduled-message-scheduler");
			// The same tests the merge path uses to choose between an offer and a bare notice.
			const noOffer = taskCompletesManually(fresh) || (await loadSettings()).suggestCompletingTasksAfterMerge === false;
			const completion = pinnedPr !== undefined ? "pinned" : noOffer ? "not-offered" : mergeCoversHead ? "offered" : "after-local-work";
			text = wrapPrStatusMessage({ prNumber, url: prUrl, notices, remaining, completion });
			const delivery = await sendMessageImmediately(fresh, text, { kind: "pane", paneId }, null, { subject: prStatusSubject(prNumber, notices), origin: "dev3" });
			log.info("PR watch delivered", {
				taskId: taskId.slice(0, 8), pr: prNumber, paneId, status: delivery.status, notices: notices.map(({ kind }) => kind).join(","),
			});
		} catch (err) {
			for (const key of keys) retryAfter.set(`${taskId}|${pinnedPr ?? "branch"}|${key}`, Date.now() + PR_WATCH_RETRY_BACKOFF_MS);
			log.warn("PR watch message not delivered; the watch stays", { taskId: taskId.slice(0, 8), error: String(err) });
			return;
		}
		for (const key of keys) retryAfter.delete(`${taskId}|${pinnedPr ?? "branch"}|${key}`);
		if (pinnedPr === undefined && notices.some(({ kind }) => kind === "merged")) {
			const now = Date.now();
			mergeOfferHolds.set(taskId, { until: now + MERGE_OFFER_WATCH_HOLD_MS, noticeText: text });
		}
		await persistWatches(project, taskId, settle);
	}
}
