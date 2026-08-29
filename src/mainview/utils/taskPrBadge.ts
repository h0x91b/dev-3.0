import type { Task, TaskPRBadgeInfo } from "../../shared/types";

export type PRIdentity = Pick<TaskPRBadgeInfo, "number" | "url">;

export function samePRIdentity(left: TaskPRBadgeInfo | null | undefined, right: PRIdentity): boolean {
	return left?.number === right.number && left.url === right.url;
}

/**
 * The PR badge a task carries on its own, with no network at all: sticky
 * `prNumber`/`prUrl` for identity plus the `prStatusCache` the backend prWatch
 * activity persists. Every status field falls back to null, so a task whose PR
 * nothing has polled yet yields an identity-only badge rather than nothing.
 */
export function taskPRBadgeFromStoredData(task: Task, identity?: PRIdentity): TaskPRBadgeInfo | null {
	const cache = task.prStatusCache;
	const sticky = task.prNumber != null && task.prUrl ? { number: task.prNumber, url: task.prUrl } : undefined;
	const cachedIdentity = cache?.url ? { number: cache.number, url: cache.url } : undefined;
	const pr = identity ?? sticky ?? cachedIdentity;
	if (!pr) return null;
	const cached = cache && samePRIdentity({ number: cache.number, url: cache.url }, pr) ? cache : null;
	return {
		number: pr.number,
		url: pr.url,
		autoMergeEnabled: cached?.autoMergeEnabled ?? null,
		ciStatus: cached?.ciStatus ?? null,
		reviewState: cached?.reviewState ?? null,
		reviewDecision: cached?.reviewDecision ?? null,
		unresolvedCount: cached?.unresolvedCount ?? null,
		mergeState: cached?.mergeState ?? null,
		checks: cached?.checks ?? [],
		prTitle: cached?.prTitle ?? null,
		isDraft: cached?.isDraft ?? null,
	};
}

/** Stored data, with the fresher in-session fields of a same-PR entry kept. */
export function mergeTaskPRBadge(
	task: Task,
	identity: PRIdentity | undefined,
	existing: TaskPRBadgeInfo | undefined,
): TaskPRBadgeInfo | null {
	const stored = taskPRBadgeFromStoredData(task, identity);
	if (!stored) return null;
	if (!existing || !samePRIdentity(existing, stored)) return stored;
	return {
		...stored,
		autoMergeEnabled: existing.autoMergeEnabled ?? stored.autoMergeEnabled,
		ciStatus: existing.ciStatus ?? stored.ciStatus,
		reviewState: existing.reviewState ?? stored.reviewState,
		reviewDecision: existing.reviewDecision ?? stored.reviewDecision,
		unresolvedCount: existing.unresolvedCount ?? stored.unresolvedCount,
		mergeState: existing.mergeState ?? stored.mergeState,
		checks: existing.checks && existing.checks.length > 0 ? existing.checks : stored.checks,
		prTitle: existing.prTitle ?? stored.prTitle,
		isDraft: existing.isDraft ?? stored.isDraft,
	};
}

export function hydrateTaskPRMap(
	tasks: Task[],
	previous = new Map<string, TaskPRBadgeInfo>(),
	identityOf?: (task: Task) => PRIdentity | undefined,
): Map<string, TaskPRBadgeInfo> {
	const next = new Map<string, TaskPRBadgeInfo>();
	for (const task of tasks) {
		const badge = mergeTaskPRBadge(task, identityOf?.(task), previous.get(task.id));
		if (badge) next.set(task.id, badge);
	}
	return next;
}

/** True when two badge maps are interchangeable, so a re-render can be skipped. */
export function samePRMap(a: Map<string, TaskPRBadgeInfo>, b: Map<string, TaskPRBadgeInfo>): boolean {
	if (a.size !== b.size) return false;
	for (const [taskId, badge] of a) {
		const other = b.get(taskId);
		if (!other) return false;
		if (badge === other) continue;
		const keys = Object.keys(badge) as (keyof TaskPRBadgeInfo)[];
		if (keys.length !== Object.keys(other).length) return false;
		for (const key of keys) {
			if (key === "checks") {
				if ((badge.checks?.length ?? 0) !== (other.checks?.length ?? 0)) return false;
				continue;
			}
			if (badge[key] !== other[key]) return false;
		}
	}
	return true;
}
