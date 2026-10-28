import type { CodingAgent, Project, Space, Task } from "../../shared/types";
import { DEFAULT_PRIORITY, spacesOfProject } from "../../shared/types";
import type { TFunction } from "../i18n";
import { type FacetResolver, isAttentionTask, taskStatusValues } from "./taskFacets";
import { getStatusLabel } from "./statusLabel";
import { childrenTokenRefs, type TaskLineage } from "./taskLineage";

/**
 * Shared builder for the token-DSL search `FacetResolver`. Labels, statuses and
 * spaces are resolved per the task's OWN project (via `projectById`), so one
 * resolver serves a single project's board, the global Active Tasks sidebar, and
 * the cross-project "Go to" palette alike. Extracted from the sidebar so every
 * surface that searches tasks shares one resolver instead of copy-pasting it.
 */
export interface FacetResolverConfig {
	agents: CodingAgent[];
	/** Every project the pool may span, by id — carries labels + custom columns. */
	projectById: Map<string, Project>;
	/** Task id → its allocated ports (empty/absent = none). */
	taskPorts: ReadonlyMap<string, readonly unknown[]>;
	spaces: Space[];
	t: TFunction;
	/** Live PR number per task, when the surface tracks one. The matcher falls
	 *  back to the task's sticky `prNumber`, so omitting it still finds by PR. */
	prNumberFor?: (task: Task) => number | null;
	/** Lineage for `children:`; a bare seq means `currentProjectId` (none ⇒ only `project/seq`). */
	lineage?: TaskLineage;
	currentProjectId?: string | null;
}

export function buildFacetResolver({ agents, projectById, taskPorts, spaces, t, prNumberFor, lineage, currentProjectId = null }: FacetResolverConfig): FacetResolver {
	return {
		agents,
		labelsFor: (task) => {
			const pool = projectById.get(task.projectId)?.labels ?? [];
			return pool.filter((l) => task.labelIds?.includes(l.id));
		},
		statusValuesFor: (task) => {
			const proj = projectById.get(task.projectId);
			const col = task.customColumnId ? proj?.customColumns?.find((c) => c.id === task.customColumnId) : undefined;
			return taskStatusValues(task, col, getStatusLabel(task.status, t, proj));
		},
		priorityFor: (task) => task.priority ?? DEFAULT_PRIORITY,
		hasPortFor: (task) => (taskPorts.get(task.id)?.length ?? 0) > 0,
		isAttentionFor: (task) => isAttentionTask(task),
		spaceNamesFor: (task) => spacesOfProject(spaces, task.projectId).map((s) => s.name),
		prNumberFor: prNumberFor ?? (() => null),
		...(lineage ? { childrenRefsFor: (task: Task) => childrenTokenRefs(task, lineage, [...projectById.values()], currentProjectId) } : {}),
	};
}
