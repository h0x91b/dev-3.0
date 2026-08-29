import { useCallback, useEffect, useRef, useState } from "react";
import type { PRInfo, Task, TaskPRBadgeInfo } from "../../shared/types";
import { api } from "../rpc";
import { startVisibilityAwarePoll } from "../utils/poll";
import { hydrateTaskPRMap, samePRMap, type PRIdentity } from "../utils/taskPrBadge";

interface UseTaskPrBadgesOptions {
	tasks: Task[];
	/**
	 * Projects to discover PRs for by matching branch names (`getProjectPRs`,
	 * once per project per minute). Omit it and the map is built purely from what
	 * each task already carries — no network at all. A surface that spans every
	 * project (the Active Tasks sidebar in global scope) must omit it: the same
	 * poll that costs the board one lookup would cost it one per project.
	 */
	discoverProjectIds?: string[];
	/** Ignore `taskPrStatus` pushes for projects this surface is not showing. */
	knowsProject?: (projectId: string) => boolean;
}

/**
 * Per-task PR badge data for any surface holding a task list.
 *
 * Two channels feed it, and the second one is easy to miss: the backend pushes
 * `taskPrStatus` — NOT `taskUpdated` — when prWatch sees new PR state, so a
 * surface that only listens to `taskUpdated` shows a `prStatusCache` that goes
 * stale mid-session.
 */
export function useTaskPrBadges({ tasks, discoverProjectIds, knowsProject }: UseTaskPrBadgesOptions): Map<string, TaskPRBadgeInfo> {
	// Branch-matched identities from the discovery poll: they are not on the task
	// yet, so hydration would drop them on the next task update without this.
	const discovered = useRef(new Map<string, PRIdentity>());
	const identityOf = useCallback(
		(task: Task) => (task.branchName ? discovered.current.get(`${task.projectId}::${task.branchName}`) : undefined),
		[],
	);
	const [map, setMap] = useState<Map<string, TaskPRBadgeInfo>>(() => hydrateTaskPRMap(tasks, undefined, identityOf));

	const rehydrate = useCallback(() => {
		setMap((prev) => {
			const next = hydrateTaskPRMap(tasks, prev, identityOf);
			return samePRMap(prev, next) ? prev : next;
		});
	}, [tasks, identityOf]);

	useEffect(rehydrate, [rehydrate]);

	const projectIdsKey = discoverProjectIds?.join(",") ?? "";
	useEffect(() => {
		if (!projectIdsKey) return;
		const projectIds = projectIdsKey.split(",");
		const fetchPRs = () => {
			// One lookup per project: a branch name is only unique inside its own
			// repository, so the branch→PR map is per project too.
			Promise.all(
				projectIds.map((projectId) =>
					api.request.getProjectPRs({ projectId }).then(
						(prs: PRInfo[]) => [projectId, prs] as const,
						() => [projectId, [] as PRInfo[]] as const,
					),
				),
			).then((results) => {
				const next = new Map<string, PRIdentity>();
				for (const [projectId, prs] of results) {
					for (const pr of prs) next.set(`${projectId}::${pr.headRefName}`, { number: pr.number, url: pr.url });
				}
				discovered.current = next;
				rehydrate();
			}).catch(() => {});
		};
		return startVisibilityAwarePoll({ fn: fetchPRs, intervalMs: 60_000 });
	}, [projectIdsKey, rehydrate]);

	useEffect(() => {
		function onPrStatus(e: Event) {
			const detail = (e as CustomEvent).detail as {
				projectId: string;
				taskId: string;
				prNumber: number | null;
				prUrl: string | null;
			} & Omit<TaskPRBadgeInfo, "number" | "url">;
			if (knowsProject && !knowsProject(detail.projectId)) return;
			setMap((prev) => {
				const existing = prev.get(detail.taskId);
				const number = detail.prNumber ?? existing?.number;
				const url = detail.prUrl ?? existing?.url;
				if (number === undefined || url === undefined) return prev;
				const next = new Map(prev);
				next.set(detail.taskId, {
					number,
					url,
					autoMergeEnabled: detail.autoMergeEnabled,
					ciStatus: detail.ciStatus,
					reviewState: detail.reviewState,
					reviewDecision: detail.reviewDecision,
					unresolvedCount: detail.unresolvedCount,
					mergeState: detail.mergeState,
					checks: detail.checks ?? [],
					prTitle: detail.prTitle,
					isDraft: detail.isDraft,
				});
				return next;
			});
		}
		window.addEventListener("rpc:taskPrStatus", onPrStatus);
		return () => window.removeEventListener("rpc:taskPrStatus", onPrStatus);
	}, [knowsProject]);

	return map;
}
