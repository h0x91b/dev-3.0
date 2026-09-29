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
export function earlierPullRequests(task: Pick<Task, "prNumber" | "pullRequests">): TaskPullRequestRecord[] {
	return (task.pullRequests ?? []).filter((entry) => entry.number !== task.prNumber).reverse();
}

/**
 * Every PR the task has had, newest first. A task no newer build has touched yet
 * has no ledger, so its legacy fields stand in for it.
 */
export function allPullRequests(task: Pick<Task, "prNumber" | "prUrl" | "prStatusCache" | "pullRequests">): TaskPullRequestRecord[] {
	const ledger = task.pullRequests ?? [];
	if (ledger.length > 0 || task.prNumber == null || !task.prUrl) return [...ledger].reverse();
	const cache = task.prStatusCache?.number === task.prNumber ? task.prStatusCache : null;
	return [{
		number: task.prNumber,
		url: task.prUrl,
		title: cache?.prTitle ?? null,
		state: cache?.mergeState?.state ?? null,
		firstSeenAt: "",
	}];
}
