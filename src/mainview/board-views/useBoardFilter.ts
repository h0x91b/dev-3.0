import { useCallback, useMemo } from "react";
import type { CodingAgent, CustomColumn, Label, PortInfo, Project, Space, Task, TaskPRBadgeInfo } from "../../shared/types";
import { ALL_PRIORITIES, ALL_STATUSES, DEFAULT_PRIORITY, normalizeLaneName } from "../../shared/types";
import { statusKey, useT } from "../i18n";
import { PRIORITY_NAME_KEYS } from "../components/priorityStyles";
import { useTaskLineage } from "../hooks/useTaskLineage";
import { useTaskPrBadges } from "../hooks/useTaskPrBadges";
import { boardFilterKey, useRememberedFilter } from "../hooks/useRememberedFilter";
import { childrenFilterToken, childrenTokenRefs, withChildrenToken, type TaskLineage } from "../utils/taskLineage";
import { matchesTaskQuery } from "../utils/taskSearch";
import {
	buildFilterGroups,
	isAttentionTask,
	taskQueryContext,
	taskStatusValues,
	type FacetResolver,
	type FilterFunnelGroup,
	type FilterFunnelOption,
} from "../utils/taskFacets";

interface UseBoardFilterOptions {
	project: Project;
	space?: Space | null;
	memberProjects?: Project[];
	tasks: Task[];
	agents: CodingAgent[];
	taskPorts: Map<string, PortInfo[]>;
	allProjects?: Project[];
}

export interface BoardFilter {
	/** The projects the board shows: the space members, or the one project. */
	boardProjects: Project[];
	knownProjects: Project[];
	boardProjectIds: ReadonlySet<string>;
	/** `null` on a space board: a bare `children:<seq>` names no project there. */
	lineageProjectId: string | null;
	query: string;
	setQuery: (query: string) => void;
	displayTasks: readonly Task[];
	matches: (task: Task, query: string) => boolean;
	labels: Label[];
	filterGroups: FilterFunnelGroup[];
	taskPrMap: Map<string, TaskPRBadgeInfo>;
	lineage: TaskLineage;
	applyChildrenFilter: (parent: { projectId: string; seq: number }) => void;
}

/**
 * The board query and everything it is evaluated against. It lives in the board
 * host because every board view shares one query (D1): switching view keeps the filter.
 */
export function useBoardFilter({ project, space, memberProjects, tasks, agents, taskPorts, allProjects }: UseBoardFilterOptions): BoardFilter {
	const t = useT();
	const isSpaceBoard = !!space;
	const boardProjects = useMemo<Project[]>(
		() => (isSpaceBoard && memberProjects && memberProjects.length > 0 ? memberProjects : [project]),
		[isSpaceBoard, memberProjects, project],
	);
	const projectById = useMemo(() => new Map(boardProjects.map((p) => [p.id, p])), [boardProjects]);
	// A space board keeps its own filter apart from its anchor project.
	const [query, setQuery] = useRememberedFilter(boardFilterKey(project.id, space?.id));

	// PR badge data: what each task already carries (sticky prNumber/prUrl +
	// prStatusCache), refreshed by the `taskPrStatus` push, plus a per-project
	// branch->PR lookup. Virtual (Operations) boards have no git repo, so they get
	// no lookup instead of a doomed RPC every 60s.
	const gitProjectIds = useMemo(
		() => boardProjects.filter((p) => p.kind !== "virtual").map((p) => p.id),
		[boardProjects],
	);
	const knowsProject = useCallback((projectId: string) => projectById.has(projectId), [projectById]);
	const taskPrMap = useTaskPrBadges({ tasks, discoverProjectIds: gitProjectIds, knowsProject });

	const lineage = useTaskLineage();
	const knownProjects = allProjects ?? boardProjects;
	const lineageProjectId = isSpaceBoard ? null : project.id;
	const boardProjectIds = useMemo(() => new Set(boardProjects.map((p) => p.id)), [boardProjects]);
	const applyChildrenFilter = useCallback((parent: { projectId: string; seq: number }) => {
		setQuery(withChildrenToken(query, childrenFilterToken(parent, knownProjects, lineageProjectId)));
	}, [query, setQuery, knownProjects, lineageProjectId]);

	// Filter chips: one per label NAME across the board's projects, same merge rule
	// as the lanes. The `label:"…"` token already matches by name, so a merged chip
	// and the token it toggles mean the same thing.
	const labels = useMemo<Label[]>(() => {
		if (!isSpaceBoard) return project.labels ?? [];
		const byName = new Map<string, Label>();
		for (const member of boardProjects) {
			for (const label of member.labels ?? []) {
				const key = label.name.trim().toLowerCase();
				if (!byName.has(key)) byName.set(key, label);
			}
		}
		return [...byName.values()];
	}, [isSpaceBoard, boardProjects, project.labels]);
	// Per project: two projects that renamed the same status cannot be reconciled,
	// so a space board uses dev3's canonical status names.
	const customStatusLabels = useMemo(
		() => (isSpaceBoard ? {} : (project.customStatusLabels ?? {})),
		[isSpaceBoard, project.customStatusLabels],
	);

	// Custom-column tasks match only their column name — where they render — never
	// their underlying status.
	const resolver: FacetResolver = useMemo(() => ({
		agents,
		labelsFor: (task) => (projectById.get(task.projectId)?.labels ?? []).filter((l) => task.labelIds?.includes(l.id)),
		statusValuesFor: (task) => {
			const ownColumns = projectById.get(task.projectId)?.customColumns ?? [];
			const col = task.customColumnId ? ownColumns.find((c) => c.id === task.customColumnId) : undefined;
			return taskStatusValues(task, col, customStatusLabels[task.status] || t(statusKey(task.status)));
		},
		priorityFor: (task) => task.priority ?? DEFAULT_PRIORITY,
		hasPortFor: (task) => (taskPorts.get(task.id)?.length ?? 0) > 0,
		isAttentionFor: isAttentionTask,
		prNumberFor: (task) => taskPrMap.get(task.id)?.number ?? null,
		prStateFor: (task) => taskPrMap.get(task.id)?.mergeState?.state ?? null,
		childrenRefsFor: (task) => childrenTokenRefs(task, lineage, knownProjects, lineageProjectId),
	}), [agents, projectById, customStatusLabels, taskPorts, taskPrMap, t, lineage, knownProjects, lineageProjectId]);

	const matches = useCallback(
		(task: Task, q: string) => !q.trim() || matchesTaskQuery(task, q, taskQueryContext(task, resolver)),
		[resolver],
	);
	const displayTasks = useMemo(
		() => (query.trim() ? tasks.filter((task) => matches(task, query)) : tasks),
		[tasks, query, matches],
	);

	// Priority leads the funnel; the board offers all five levels (P0…P4).
	const priorityCandidates = useMemo<FilterFunnelOption[]>(
		() => ALL_PRIORITIES.map((p) => ({ facet: "priority" as const, value: p, label: `${p} — ${t(PRIORITY_NAME_KEYS[p])}` })),
		[t],
	);
	// One entry per custom LANE — merged by name across the board's projects, so a
	// space board offers "On hold" once however many projects have it.
	const boardCustomColumns = useMemo<CustomColumn[]>(() => {
		if (!isSpaceBoard) return project.customColumns ?? [];
		const byName = new Map<string, CustomColumn>();
		for (const member of boardProjects) {
			for (const col of member.customColumns ?? []) {
				const key = normalizeLaneName(col.name);
				if (!byName.has(key)) byName.set(key, col);
			}
		}
		return [...byName.values()];
	}, [isSpaceBoard, boardProjects, project.customColumns]);
	const statusCandidates = useMemo<FilterFunnelOption[]>(() => [
		...ALL_STATUSES.map((s) => ({ facet: "status" as const, value: s, label: customStatusLabels[s] || t(statusKey(s)) })),
		...boardCustomColumns.map((c) => ({ facet: "status" as const, value: c.name, label: c.name, color: c.color })),
	], [customStatusLabels, boardCustomColumns, t]);

	const filterGroups = useMemo(
		() => buildFilterGroups(tasks, resolver, {
			priorityCandidates,
			statusCandidates,
			flagLabels: {
				attention: t("filter.flag.attention"),
				port: t("filter.flag.port"),
				home: t("spaces.homeGroup"),
				hidden: t("filter.flag.hidden"),
				hibernated: t("filter.flag.hibernated"),
				keptAlive: t("filter.flag.keepAlive"),
			},
			typeLabels: {
				standard: t("createTask.taskTypeStandard"),
				coordinator: t("createTask.taskTypeCoordinator"),
				"pr-review": t("createTask.taskTypeReview"),
				"board-cleanup": t("createTask.taskTypeCleanup"),
			},
		}),
		[tasks, resolver, priorityCandidates, statusCandidates, t],
	);

	return {
		boardProjects,
		knownProjects,
		boardProjectIds,
		lineageProjectId,
		query,
		setQuery,
		displayTasks,
		matches,
		labels,
		filterGroups,
		taskPrMap,
		lineage,
		applyChildrenFilter,
	};
}
