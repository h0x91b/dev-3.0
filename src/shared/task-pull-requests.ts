import type { Task, TaskPullRequestRecord } from "./types";

export interface PullRequestSighting {
	number: number;
	url: string;
	state?: string | null;
	title?: string | null;
}

type LedgerTask = Pick<Task, "prNumber" | "prUrl" | "prStatusCache" | "pullRequests">;

function upsert(ledger: TaskPullRequestRecord[], sighting: PullRequestSighting, seenAt: string): boolean {
	const index = ledger.findIndex((entry) => entry.number === sighting.number);
	if (index === -1) {
		ledger.push({
			number: sighting.number,
			url: sighting.url,
			...(sighting.title ? { title: sighting.title } : {}),
			...(sighting.state ? { state: sighting.state.toUpperCase() } : {}),
			firstSeenAt: seenAt,
		});
		return true;
	}
	const entry = ledger[index];
	const next: TaskPullRequestRecord = {
		...entry,
		...(sighting.url && sighting.url !== entry.url ? { url: sighting.url } : {}),
		...(sighting.title && sighting.title !== entry.title ? { title: sighting.title } : {}),
		...(sighting.state && sighting.state.toUpperCase() !== entry.state ? { state: sighting.state.toUpperCase() } : {}),
	};
	if (next.url === entry.url && next.title === entry.title && next.state === entry.state) return false;
	ledger[index] = next;
	return true;
}

/**
 * The task's PR ledger after one sighting of its current PR, or null when nothing
 * changed. The PR being replaced is recorded first, from the fields about to be
 * overwritten, so a PR survives in the ledger once any version has seen it.
 */
export function recordPullRequestSighting(
	task: LedgerTask,
	sighting: PullRequestSighting,
	seenAt: string,
): TaskPullRequestRecord[] | null {
	const ledger = [...(task.pullRequests ?? [])];
	let changed = false;
	if (task.prNumber != null && task.prUrl && task.prNumber !== sighting.number) {
		const cache = task.prStatusCache?.number === task.prNumber ? task.prStatusCache : null;
		changed = upsert(ledger, {
			number: task.prNumber,
			url: task.prUrl,
			state: cache?.mergeState?.state ?? null,
			title: cache?.prTitle ?? null,
		}, seenAt) || changed;
	}
	changed = upsert(ledger, sighting, seenAt) || changed;
	return changed ? ledger : null;
}

/** The finished PRs a follow-up replaced, newest first. */
export function earlierPullRequests(task: Pick<Task, "prNumber" | "pullRequests"> & TaskWithStatus): TaskPullRequestRecord[] {
	return (task.pullRequests ?? []).filter((entry) => entry.number !== task.prNumber).reverse().map((entry) => trustedRecord(task, entry));
}

/**
 * Every PR the task has had, newest first. A task no newer build has touched yet
 * has no ledger, so its legacy fields stand in for it.
 */
export function allPullRequests(task: Pick<Task, "prNumber" | "prUrl" | "prStatusCache" | "pullRequests"> & TaskWithStatus): TaskPullRequestRecord[] {
	const ledger = task.pullRequests ?? [];
	if (ledger.length > 0 || task.prNumber == null || !task.prUrl) return [...ledger].reverse().map((entry) => trustedRecord(task, entry));
	const cache = task.prStatusCache?.number === task.prNumber ? trustedPrStatusCache(task) : null;
	return [{
		number: task.prNumber,
		url: task.prUrl,
		title: cache?.prTitle ?? null,
		state: cache?.mergeState?.state ?? null,
		firstSeenAt: "",
	}];
}

/** MERGED is immutable, so the saved state is proof without a network read. */
export function savedPrMergedFromBranch(
	task: Pick<Task, "prNumber" | "prStatusCache">,
	branch: string | null | undefined,
): boolean {
	const cache = task.prStatusCache;
	return task.prNumber != null
		&& !!branch
		&& cache?.number === task.prNumber
		&& cache.mergeState?.state === "MERGED"
		&& cache.headRefName === branch;
}

/** Callers that know nothing about the task's column count as live. */
type TaskWithStatus = { status?: Task["status"] };

const FINISHED_TASK_STATUSES = new Set<Task["status"]>(["completed", "cancelled"]);

/**
 * Whether a stored PR state can still be believed. Nothing polls a finished task's
 * PR, so its last OPEN froze before the merge or close it was waiting on; only the
 * final states (MERGED, CLOSED) stay true forever.
 */
export function isTrustedStoredPrState(task: TaskWithStatus, state: string | null | undefined): boolean {
	if (!state) return false;
	return !task.status || !FINISHED_TASK_STATUSES.has(task.status) || state.toUpperCase() !== "OPEN";
}

function trustedRecord(task: TaskWithStatus, entry: TaskPullRequestRecord): TaskPullRequestRecord {
	return entry.state && !isTrustedStoredPrState(task, entry.state) ? { ...entry, state: null } : entry;
}

/**
 * The task's PR status cache with a stale (see {@link isTrustedStoredPrState}) merge
 * state dropped whole: its mergeable/status described an open PR that has since moved on.
 */
export function trustedPrStatusCache(task: Pick<Task, "prStatusCache"> & TaskWithStatus): Task["prStatusCache"] {
	const cache = task.prStatusCache;
	if (!cache?.mergeState?.state || isTrustedStoredPrState(task, cache.mergeState.state)) return cache;
	return { ...cache, mergeState: null };
}
