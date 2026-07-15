import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import { toast } from "../toast";
import type { BoardColumnSlot, CodingAgent, CustomColumn, GlobalSettings, PortInfo, PRInfo, Project, ResourceUsage, Task, TaskPRBadgeInfo, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES, ALL_PRIORITIES, getBoardColumns, DEFAULT_PRIORITY } from "../../shared/types";
import { PRIORITY_NAME_KEYS } from "./priorityStyles";

// Column ordering + visibility lives in the shared, unit-tested getBoardColumns
// (single source of truth for the board's column layout).
type ColumnSlot = BoardColumnSlot;
import type { AppAction, Route } from "../state";
import { useT, statusKey, statusDescKey } from "../i18n";
import { api } from "../rpc";
import KanbanColumn from "./KanbanColumn";
import LaunchVariantsModal from "./LaunchVariantsModal";
import { sortTasksForColumn } from "./sortTasks";
import LabelFilterBar from "./LabelFilterBar";
import { matchesTaskQuery } from "../utils/taskSearch";
import { buildFilterGroups, taskQueryContext, isAttentionTask, type FacetResolver, type FilterFunnelOption } from "../utils/taskFacets";
import { startVisibilityAwarePoll } from "../utils/poll";
import { useTipRotation } from "../hooks/useTipRotation";
import { useColumnCollapse } from "../hooks/useColumnCollapse";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useStatusColors } from "../hooks/useStatusColors";
import MobileBoardCarousel, { CAROUSEL_MAX_WIDTH, type CarouselColumn } from "./MobileBoardCarousel";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
	disableGlobalFindShortcut?: boolean;
}

type PRIdentity = Pick<TaskPRBadgeInfo, "number" | "url">;

function samePRIdentity(left: TaskPRBadgeInfo | null | undefined, right: PRIdentity): boolean {
	return left?.number === right.number && left.url === right.url;
}

function taskPRBadgeFromStoredData(task: Task, identity?: PRIdentity): TaskPRBadgeInfo | null {
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

function mergeTaskPRBadge(task: Task, identity: PRIdentity | undefined, existing: TaskPRBadgeInfo | undefined): TaskPRBadgeInfo | null {
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

function hydrateTaskPRMap(tasks: Task[], previous = new Map<string, TaskPRBadgeInfo>()): Map<string, TaskPRBadgeInfo> {
	const next = new Map<string, TaskPRBadgeInfo>();
	for (const task of tasks) {
		const badge = mergeTaskPRBadge(task, undefined, previous.get(task.id));
		if (badge) next.set(task.id, badge);
	}
	return next;
}

function KanbanBoard({
	project,
	tasks,
	dispatch,
	navigate,
	bellCounts,
	bellReasons,
	taskPorts,
	taskResourceUsage,
	activeTaskId,
	disableGlobalFindShortcut = false,
}: KanbanBoardProps) {
	const t = useT();
	const isCarousel = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const statusColors = useStatusColors();
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-auto",
		taskDropPosition: "top",
		updateChannel: "stable",
	});
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus; mode?: "spawn" | "addAttempts" } | null>(null);
	const [dragFromStatus, setDragFromStatus] = useState<TaskStatus | null>(null);
	const [dragFromCustomColumnId, setDragFromCustomColumnId] = useState<string | null>(null);
	const [moveOrderMap, setMoveOrderMap] = useState<Map<string, number>>(new Map());
	const [searchQuery, setSearchQuery] = useState("");
	const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
	const moveCounterRef = useRef(0);
	const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
	// Ref so drag handlers can check synchronously without waiting for state update
	const draggedColumnIdRef = useRef<string | null>(null);
	// Custom column just created from the board's "+" — opens directly in rename mode.
	const [autoEditColumnId, setAutoEditColumnId] = useState<string | null>(null);
	// Feature-discovery tip rotation (board context). Shared logic lives in the hook.
	const { tip: currentTip, tipState, applyTipState } = useTipRotation("board", globalSettings.tipsDisabled);
	const collapseState = useColumnCollapse(project.id);

	// PR badge data for task cards. Seed from persisted task metadata so the board
	// stays useful while the first live GitHub lookup is still in flight.
	const [taskPrMap, setTaskPrMap] = useState<Map<string, TaskPRBadgeInfo>>(() => hydrateTaskPRMap(tasks));

	const handleSetMoving = useCallback((taskId: string, isMoving: boolean) => {
		setMovingTaskIds((prev) => {
			const next = new Set(prev);
			if (isMoving) next.add(taskId);
			else next.delete(taskId);
			return next;
		});
	}, []);

	function recordMove(taskId: string) {
		moveCounterRef.current += 1;
		setMoveOrderMap((prev) => new Map(prev).set(taskId, moveCounterRef.current));
	}

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
		api.request.getGlobalSettings().then(setGlobalSettings).catch(() => {});
	}, []);

	useEffect(() => {
		setTaskPrMap((prev) => {
			const next = new Map<string, TaskPRBadgeInfo>();
			for (const task of tasks) {
				const existing = prev.get(task.id);
				const badge = existing ?? taskPRBadgeFromStoredData(task);
				if (badge) next.set(task.id, badge);
			}
			if (next.size === prev.size && [...next.keys()].every((taskId) => prev.has(taskId))) return prev;
			return next;
		});
	}, [project.id, tasks]);

	// Fetch open PRs for the project and map branch names to task IDs. CI/review
	// state is supplied separately by the background poller's `taskPrStatus`
	// push, so preserve any already-known ci/review fields when rebuilding here.
	const fetchPRs = useCallback(() => {
		api.request.getProjectPRs({ projectId: project.id }).then((prs: PRInfo[]) => {
			const branchToPR = new Map<string, { number: number; url: string }>();
			for (const pr of prs) {
				branchToPR.set(pr.headRefName, { number: pr.number, url: pr.url });
			}
			setTaskPrMap((prev) => {
				const map = new Map<string, TaskPRBadgeInfo>();
				for (const task of tasks) {
					const discovered = task.branchName ? branchToPR.get(task.branchName) : undefined;
					const stored = taskPRBadgeFromStoredData(task, discovered);
					const existing = prev.get(task.id);
					const badge = stored && existing && samePRIdentity(existing, stored) ? existing : stored;
					if (badge) map.set(task.id, badge);
				}
				return map;
			});
		}).catch(() => {});
	}, [project.id, tasks]);

	useEffect(() => {
		// Virtual (Operations) boards have no git repo, branches, or PRs — skip the
		// poll entirely instead of firing a doomed getProjectPRs RPC every 60s.
		if (project.kind === "virtual") return;
		return startVisibilityAwarePoll({ fn: fetchPRs, intervalMs: 60_000 });
	}, [fetchPRs, project.kind]);

	// CI/review status pushed by the background PR poller — merge onto the
	// existing PR badge entry (carrying number/url forward if already known).
	useEffect(() => {
		function onPrStatus(e: Event) {
			const detail = (e as CustomEvent).detail as {
				projectId: string;
				taskId: string;
				prNumber: number | null;
				prUrl: string | null;
				autoMergeEnabled?: TaskPRBadgeInfo["autoMergeEnabled"];
				ciStatus: TaskPRBadgeInfo["ciStatus"];
				reviewState: TaskPRBadgeInfo["reviewState"];
				reviewDecision?: TaskPRBadgeInfo["reviewDecision"];
				unresolvedCount: TaskPRBadgeInfo["unresolvedCount"];
				mergeState: TaskPRBadgeInfo["mergeState"];
				checks: TaskPRBadgeInfo["checks"];
				prTitle: TaskPRBadgeInfo["prTitle"];
				isDraft: TaskPRBadgeInfo["isDraft"];
			};
			if (detail.projectId !== project.id) return;
			setTaskPrMap((prev) => {
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
	}, [project.id]);

	// Global dragend listener to clear drag state
	useEffect(() => {
		function handleDragEnd() {
			setDragFromStatus(null);
			setDragFromCustomColumnId(null);
			setDraggedTaskId(null);
		}
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

	function handleDragStart(taskId: string) {
		const task = tasks.find((t) => t.id === taskId);
		if (task) {
			setDragFromStatus(task.status);
			setDragFromCustomColumnId(task.customColumnId ?? null);
			setDraggedTaskId(taskId);
		}
	}

	async function handleTaskDrop(taskId: string, targetStatus: TaskStatus) {
		setDragFromStatus(null);
		setDragFromCustomColumnId(null);
		const task = tasks.find((t) => t.id === taskId);
		if (!task) return;

		// If already in target status and no custom column, nothing to do
		if (task.status === targetStatus && !task.customColumnId) return;

		// todo → active: open LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(targetStatus) && !task.worktreePath) {
			setLaunchModal({ task, targetStatus });
			return;
		}

		await moveTaskToStatus({
			task,
			project,
			newStatus: targetStatus,
			dispatch,
			t,
			onMoved: () => recordMove(task.id),
			onMovingChange: (moving) => handleSetMoving(task.id, moving),
		});
	}

	async function handleTaskDropToCustomColumn(taskId: string, customColumnId: string) {
		setDragFromStatus(null);
		setDragFromCustomColumnId(null);
		const task = tasks.find((t) => t.id === taskId);
		if (!task || task.customColumnId === customColumnId) return;

		// Optimistic update
		const optimisticTask = { ...task, customColumnId };
		dispatch({ type: "updateTask", task: optimisticTask });
		recordMove(task.id);
		setMovingTaskIds((prev) => new Set(prev).add(task.id));

		try {
			const updated = await api.request.moveTaskToCustomColumn({
				taskId: task.id,
				projectId: project.id,
				customColumnId,
			});
			dispatch({ type: "updateTask", task: updated });
		} catch (err) {
			dispatch({ type: "updateTask", task });
			toast.error(t("task.failedMove", { error: String(err) }), { taskId: task.id });
		} finally {
			setMovingTaskIds((prev) => {
				const next = new Set(prev);
				next.delete(task.id);
				return next;
			});
		}
	}

	async function handleReorderTask(taskId: string, targetIndex: number) {
		try {
			const updatedTasks = await api.request.reorderTask({
				taskId,
				projectId: project.id,
				targetIndex,
			});
			for (const task of updatedTasks) {
				dispatch({ type: "updateTask", task });
			}
			// Clear in-session move order so persisted columnOrder takes effect
			setMoveOrderMap((prev) => {
				const next = new Map(prev);
				next.delete(taskId);
				return next;
			});
		} catch (err) {
			console.error("Failed to reorder task:", err);
		}
	}

	// Build sibling map: groupId → all tasks with that groupId (from full tasks list, not filtered)
	const siblingMap = useMemo(() => {
		const map = new Map<string, Task[]>();
		for (const task of tasks) {
			if (task.groupId) {
				const existing = map.get(task.groupId);
				if (existing) {
					existing.push(task);
				} else {
					map.set(task.groupId, [task]);
				}
			}
		}
		return map;
	}, [tasks]);

	const projectLabels = project.labels ?? [];
	const customColumns: CustomColumn[] = project.customColumns ?? [];
	const customStatusLabels = project.customStatusLabels ?? {};
	const customColumnIds = new Set(customColumns.map((c) => c.id));
	// A task belongs to a custom column only if that column still exists. A
	// dangling customColumnId (its column was deleted, or a multi-instance write
	// referenced a column this instance never had) falls back to the task's
	// underlying status column so the task can never silently vanish from the board.
	const isInCustomColumn = (task: Task) => !!task.customColumnId && customColumnIds.has(task.customColumnId);

	// Facet resolver + funnel pool for the token-DSL filter. Custom-column tasks
	// report the column name as their canonical status value (mirrors where they
	// render), while still matching their underlying built-in status.
	const resolver: FacetResolver = useMemo(() => ({
		agents,
		labelsFor: (task) => projectLabels.filter((l) => task.labelIds?.includes(l.id)),
		statusValuesFor: (task) => {
			const col = task.customColumnId ? customColumns.find((c) => c.id === task.customColumnId) : undefined;
			const label = customStatusLabels[task.status] || t(statusKey(task.status));
			return col ? [col.name, task.status, label] : [task.status, label];
		},
		priorityFor: (task) => task.priority ?? DEFAULT_PRIORITY,
		hasPortFor: (task) => (taskPorts.get(task.id)?.length ?? 0) > 0,
		isAttentionFor: isAttentionTask,
		prNumberFor: (task) => taskPrMap.get(task.id)?.number ?? null,
	}), [agents, projectLabels, customColumns, customStatusLabels, taskPorts, taskPrMap, t]);

	// Priority leads the funnel; the board offers all five levels (P0…P4).
	const priorityCandidates = useMemo<FilterFunnelOption[]>(
		() => ALL_PRIORITIES.map((p) => ({ facet: "priority" as const, value: p, label: `${p} — ${t(PRIORITY_NAME_KEYS[p])}` })),
		[t],
	);
	// The board offers every board status (plus custom columns) in the funnel.
	const statusCandidates = useMemo<FilterFunnelOption[]>(() => [
		...ALL_STATUSES.map((s) => ({ facet: "status" as const, value: s, label: customStatusLabels[s] || t(statusKey(s)) })),
		...customColumns.map((c) => ({ facet: "status" as const, value: c.name, label: c.name, color: c.color })),
	], [customStatusLabels, customColumns, t]);

	const filterGroups = useMemo(
		() => buildFilterGroups(tasks, resolver, {
			priorityCandidates,
			statusCandidates,
			flagLabels: { attention: t("filter.flag.attention"), port: t("filter.flag.port") },
		}),
		[tasks, resolver, priorityCandidates, statusCandidates, t],
	);

	// Labels shown inline are ordered by popularity (how many tasks use each), so
	// the funnel/"+N more" hides the least-used first.
	const popularLabels = useMemo(() => {
		const count = new Map<string, number>();
		for (const task of tasks) for (const id of task.labelIds ?? []) count.set(id, (count.get(id) ?? 0) + 1);
		return [...projectLabels].sort((a, b) => (count.get(b.id) ?? 0) - (count.get(a.id) ?? 0));
	}, [tasks, projectLabels]);

	async function handleRenameBuiltinColumn(status: TaskStatus, name: string | null) {
		try {
			const updated = await api.request.renameBuiltinColumn({ projectId: project.id, status, name });
			dispatch({ type: "updateProject", project: updated });
		} catch (err) {
			console.error("Failed to rename column:", err);
		}
	}

	// Create a custom column straight from the board (issue #222): the server picks
	// a distinct color; insert it immediately before Completed and flag it for inline
	// renaming so the user names it in place instead of opening Project Settings.
	// Advanced config (color, LLM instruction, agent) stays in Project Settings —
	// progressive disclosure.
	async function handleCreateCustomColumn() {
		try {
			const column = await api.request.createCustomColumn({
				projectId: project.id,
				name: t("customColumns.defaultName"),
			});
			const currentOrder = getOrderedColumns().map((slot) => slot.type === "builtin" ? slot.status : slot.col.id);
			const completedIndex = currentOrder.indexOf("completed");
			const columnOrder = [...currentOrder];
			columnOrder.splice(completedIndex === -1 ? columnOrder.length : completedIndex, 0, column.id);
			dispatch({
				type: "updateProject",
				project: { ...project, customColumns: [...customColumns, column], columnOrder },
			});
			// The create RPC returns only the new column, so persist the full board order
			// explicitly after creation. The server has committed the column by this point.
			api.request.reorderColumns({ projectId: project.id, columnOrder }).catch((err) => {
				toast.error(t("kanban.failedReorderColumns", { error: String(err) }));
			});
			setAutoEditColumnId(column.id);
		} catch (err) {
			toast.error(t("customColumns.failedCreate", { error: String(err) }));
		}
	}

	// Inline rename of a board custom column. Only the name changes; the merge on
	// the server preserves color, instruction, and agent config.
	async function handleRenameCustomColumn(columnId: string, name: string) {
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			const column = await api.request.updateCustomColumn({ projectId: project.id, columnId, name: trimmed });
			dispatch({
				type: "updateProject",
				project: { ...project, customColumns: customColumns.map((c) => (c.id === columnId ? column : c)) },
			});
		} catch (err) {
			toast.error(t("customColumns.failedUpdate", { error: String(err) }));
		}
	}

	// Apply the token-DSL filter (facets + free text) — the search string is the
	// single source of truth; the old separate `activeFilters` state is gone.
	let displayTasks = tasks;
	if (searchQuery.trim()) {
		displayTasks = displayTasks.filter((task) => matchesTaskQuery(task, searchQuery, taskQueryContext(task, resolver)));
	}

	// Built-in column tasks (exclude tasks in an existing custom column; tasks
	// with a dangling customColumnId fall back here into their status column).
	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of displayTasks) {
		if (!isInCustomColumn(task)) {
			tasksByStatus.get(task.status)?.push(task);
		}
	}

	// Sort tasks within each built-in column for variant grouping
	for (const status of ALL_STATUSES) {
		const columnTasks = tasksByStatus.get(status);
		if (columnTasks && columnTasks.length > 1) {
			tasksByStatus.set(status, sortTasksForColumn(columnTasks, globalSettings.taskDropPosition, moveOrderMap));
		}
	}

	// Returns all columns in their effective display order (delegates to the
	// shared getBoardColumns). "Your Review" stays even on virtual boards: a
	// finished ops task is handed
	// back via review-by-user, so hiding it would drop the task off the board.
	function getOrderedColumns(): ColumnSlot[] {
		const aiReviewHasItems = tasks.some((t) => t.status === "review-by-ai" && !isInCustomColumn(t));
		return getBoardColumns(project, { aiReviewHasItems });
	}

	function handleColumnDragStart(colId: string) {
		draggedColumnIdRef.current = colId;
		setDraggedColumnId(colId);
	}

	// Called by any column when a custom column is dragged over it
	function handleColumnDrop(targetColId: string, side: "before" | "after") {
		const srcColId = draggedColumnIdRef.current;
		if (!srcColId || srcColId === targetColId) return;
		const currentOrder = getOrderedColumns().map((c) => c.type === "builtin" ? c.status : c.col.id);
		const fromIndex = currentOrder.indexOf(srcColId);
		const toIndex = currentOrder.indexOf(targetColId);
		if (fromIndex === -1 || toIndex === -1) return;
		let insertAt = side === "after" ? toIndex + 1 : toIndex;
		if (fromIndex < insertAt) insertAt -= 1;
		const newOrder = [...currentOrder];
		newOrder.splice(fromIndex, 1);
		newOrder.splice(insertAt, 0, srcColId);
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
		// Reorder customColumns array to match new order
		const reorderedCustom = newOrder
			.map((id) => customColumns.find((c) => c.id === id))
			.filter((c): c is CustomColumn => c !== undefined);
		dispatch({ type: "updateProject", project: { ...project, customColumns: reorderedCustom, columnOrder: newOrder } });
		api.request.reorderColumns({ projectId: project.id, columnOrder: newOrder }).catch((err) => {
			toast.error(t("kanban.failedReorderColumns", { error: String(err) }));
		});
	}

	function handleColumnDragEnd() {
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
	}

	// Custom column tasks
	const tasksByCustomColumn = new Map<string, Task[]>();
	for (const col of customColumns) {
		tasksByCustomColumn.set(col.id, []);
	}
	for (const task of displayTasks) {
		if (isInCustomColumn(task)) {
			tasksByCustomColumn.get(task.customColumnId!)?.push(task);
		}
	}

	// Find the first column with <2 tasks for the tip card (only one tip across the board)
	// Exclude collapsed columns from tip placement
	const tipColumnId: string | null = useMemo(() => {
		if (!currentTip) return null;
		const orderedCols = getOrderedColumns();
		for (const slot of orderedCols) {
			const colId = slot.type === "builtin" ? slot.status : slot.col.id;
			if (collapseState.isCollapsed(colId)) continue;
			if (slot.type === "builtin") {
				const count = tasksByStatus.get(slot.status)?.length ?? 0;
				if (count < 3) return slot.status;
			} else {
				const count = tasksByCustomColumn.get(slot.col.id)?.length ?? 0;
				if (count < 3) return slot.col.id;
			}
		}
		return null;
	}, [currentTip, displayTasks, collapseState]);

	const orderedColumns = getOrderedColumns();
	const handleTipChanged = applyTipState;

	// Add-column affordance for the desktop board (issue #222). Rendered just before
	// the Completed column so it stays in the active-lifecycle region of the board.
	const addColumnButton = (
		<button
			key="add-column"
			type="button"
			onClick={handleCreateCustomColumn}
			className="group/addcol flex-shrink-0 self-stretch w-11 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-edge text-fg-3 hover:text-accent hover:border-accent/40 hover:bg-accent/5 transition-colors"
			aria-label={t("customColumns.addColumnAria")}
			title={t("customColumns.addColumnAria")}
		>
			<span className="text-2xl leading-none">+</span>
			<span className="kanban-col-vertical-label text-xs font-semibold whitespace-nowrap opacity-0 group-hover/addcol:opacity-100 transition-opacity">
				{t("customColumns.addColumnAria")}
			</span>
		</button>
	);
	const commonProps = {
		project,
		dispatch,
		navigate,
		onAddTask: () => window.dispatchEvent(new CustomEvent("rpc:openCreateTaskModal")),
		agents,
		onLaunchVariants: (task: Task, targetStatus: TaskStatus) =>
			setLaunchModal({ task, targetStatus }),
		onAddAttempts: (task: Task) =>
			setLaunchModal({ task, targetStatus: task.status, mode: "addAttempts" }),
		onTaskDrop: handleTaskDrop,
		onReorderTask: handleReorderTask,
		dragFromStatus,
		dragFromCustomColumnId,
		onDragStart: handleDragStart,
		onTaskMoved: recordMove,
		bellCounts,
		bellReasons,
		taskPorts,
		taskResourceUsage,
		activeTaskId,
		draggedTaskId,
		movingTaskIds,
		siblingMap,
		onSetMoving: handleSetMoving,
		taskPrMap,
	};

	function renderColumnElement(slot: ColumnSlot, full: boolean) {
		if (slot.type === "builtin") {
			const colId = slot.status;
			return (
				<KanbanColumn
					key={slot.status}
					status={slot.status}
					label={customStatusLabels[slot.status] || t(statusKey(slot.status))}
					description={t(statusDescKey(slot.status))}
					tasks={tasksByStatus.get(slot.status) || []}
					onColumnDrop={(side) => handleColumnDrop(slot.status, side)}
					tip={tipColumnId === slot.status ? currentTip : undefined}
					onTipChanged={handleTipChanged}
					tipState={tipState ?? undefined}
					collapsed={full ? false : collapseState.isCollapsed(colId)}
					onCollapseToggle={full ? undefined : () => collapseState.toggle(colId)}
					collapseDragHandlers={full ? undefined : collapseState.dragExpandHandlers(colId)}
					onRenameColumn={(name) => handleRenameBuiltinColumn(slot.status, name)}
					fullWidth={full}
					{...commonProps}
				/>
			);
		}
		const col = slot.col;
		return (
			<KanbanColumn
				key={col.id}
				status="todo"
				label={col.name}
				tasks={tasksByCustomColumn.get(col.id) || []}
				onTaskDropToCustomColumn={handleTaskDropToCustomColumn}
				isCustomColumn
				customColumnId={col.id}
				colorOverride={col.color}
				isDraggedColumn={draggedColumnId === col.id}
				onColumnDragStart={() => handleColumnDragStart(col.id)}
				onColumnDragEnd={handleColumnDragEnd}
				onColumnDrop={(side) => handleColumnDrop(col.id, side)}
				onRenameColumn={(name) => handleRenameCustomColumn(col.id, name ?? "")}
				autoStartEditing={autoEditColumnId === col.id}
				onAutoEditConsumed={() => setAutoEditColumnId(null)}
				tip={tipColumnId === col.id ? currentTip : undefined}
				onTipChanged={handleTipChanged}
				tipState={tipState ?? undefined}
				fullWidth={full}
				{...commonProps}
			/>
		);
	}

	// Carousel mode: one column per screen. Built-in collapsed defaults remain
	// reachable on mobile; only columns explicitly collapsed by the user are
	// excluded from rotation. Empty columns stay for position stability.
	const carouselColumns: CarouselColumn[] = isCarousel
		? orderedColumns
				.filter((slot) => !collapseState.isUserCollapsed(slot.type === "builtin" ? slot.status : slot.col.id))
				.map((slot) =>
					slot.type === "builtin"
						? {
								id: slot.status,
								label: customStatusLabels[slot.status] || t(statusKey(slot.status)),
								color: statusColors[slot.status],
								count: tasksByStatus.get(slot.status)?.length ?? 0,
								element: renderColumnElement(slot, true),
							}
						: {
								id: slot.col.id,
								label: slot.col.name,
								color: slot.col.color ?? statusColors.todo,
								count: tasksByCustomColumn.get(slot.col.id)?.length ?? 0,
								element: renderColumnElement(slot, true),
							},
				)
		: [];
	const initialColumnId = carouselColumns.find((column) => column.id === "user-questions" && column.count > 0)?.id
		?? carouselColumns.find((column) => column.id === "review-by-user" && column.count > 0)?.id;

	return (
		<>
			<LabelFilterBar
				labels={popularLabels}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
				filterGroups={filterGroups}
				disableGlobalFindShortcut={disableGlobalFindShortcut}
			/>
			{isCarousel ? (
				<MobileBoardCarousel columns={carouselColumns} initialColumnId={initialColumnId} />
			) : (
				<div className="flex-1 min-h-0 flex gap-5 px-6 pb-6 pt-2 overflow-x-auto overflow-y-hidden kanban-scroll">
					{(() => {
						// Add-column affordance (issue #222): a slim dashed ghost strip that
						// reuses the board's "+" idiom — no toolbar button. It sits right
						// before the Completed column (the end-of-lifecycle boundary), not at
						// the very end past Cancelled.
						const hasCompleted = orderedColumns.some((s) => s.type === "builtin" && s.status === "completed");
						return orderedColumns.flatMap((slot) => {
							const el = renderColumnElement(slot, false);
							const beforeCompleted = slot.type === "builtin" && slot.status === "completed";
							return beforeCompleted ? [addColumnButton, el] : [el];
							// Defensive fallback handled below when Completed is somehow absent.
						}).concat(hasCompleted ? [] : [addColumnButton]);
					})()}
				</div>
			)}

			{launchModal && (
				<LaunchVariantsModal
					task={launchModal.task}
					project={project}
					targetStatus={launchModal.targetStatus}
					agents={agents}
					globalSettings={globalSettings}
					dispatch={dispatch}
					onClose={() => setLaunchModal(null)}
					mode={launchModal.mode}
					onGlobalSettingsChange={setGlobalSettings}
				/>
			)}
		</>
	);
}

export default KanbanBoard;
