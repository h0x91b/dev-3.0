import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import { toast } from "../toast";
import type { BoardColumnSlot, CustomColumn, DevServerSummary, GlobalSettings, Label, PortInfo, Project, ResourceUsage, Space, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES, ALL_PRIORITIES, getBoardColumns, laneAcceptsProject, laneColumnIdForProject, laneKey, normalizeLaneName, DEFAULT_PRIORITY } from "../../shared/types";
import { PRIORITY_NAME_KEYS } from "./priorityStyles";

// Column ordering + visibility lives in the shared, unit-tested getBoardColumns
// (single source of truth for the board's column layout).
type ColumnSlot = BoardColumnSlot;
import { getTaskOpenMode, type AppAction, type Route } from "../state";
import { useT, statusKey, statusDescKey } from "../i18n";
import { api } from "../rpc";
import KanbanColumn from "./KanbanColumn";
import LaunchVariantsModal from "./LaunchVariantsModal";
import CreateTaskModal from "./CreateTaskModal";
import { sortTasksForColumn } from "./sortTasks";
import { partitionTasksByStatus } from "./partitionTasks";
import LabelFilterBar from "./LabelFilterBar";
import { matchesTaskQuery } from "../utils/taskSearch";
import { buildFilterGroups, taskQueryContext, isAttentionTask, type FacetResolver, type FilterFunnelOption } from "../utils/taskFacets";
import { useTaskPrBadges } from "../hooks/useTaskPrBadges";
import { useTipRotation } from "../hooks/useTipRotation";
import { useColumnCollapse } from "../hooks/useColumnCollapse";
import { moveTaskToStatus } from "../utils/moveTaskToStatus";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { useStatusColors } from "../hooks/useStatusColors";
import { useAgents } from "../hooks/useAgents";
import MobileBoardCarousel, { CAROUSEL_MAX_WIDTH, type CarouselColumn } from "./MobileBoardCarousel";

interface KanbanBoardProps {
	/**
	 * The board's anchor project: its own subject on a project board, and on a
	 * space board the project the user zoomed out of (it still owns the route, the
	 * breadcrumb, and anything asked of "the current project").
	 */
	project: Project;
	/**
	 * The space this board is ABOUT. Set ⇒ every member project's tasks share one
	 * set of lanes; unset ⇒ today's project board, unchanged.
	 */
	space?: Space | null;
	/** Member projects of `space`, in display order. Ignored without a space. */
	memberProjects?: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskDevServers: Map<string, DevServerSummary>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
	disableGlobalFindShortcut?: boolean;
	onOpenUnresolvedComments?: (task: Task) => void;
}

function KanbanBoard({
	project,
	space,
	memberProjects,
	tasks,
	dispatch,
	navigate,
	bellCounts,
	bellReasons,
	taskPorts,
	taskDevServers,
	taskResourceUsage,
	activeTaskId,
	disableGlobalFindShortcut = false,
	onOpenUnresolvedComments,
}: KanbanBoardProps) {
	const t = useT();
	// A space is the subject; without one everything below collapses to the single
	// anchor project and the board renders exactly what it renders today.
	const isSpaceBoard = !!space;
	const boardProjects = useMemo<Project[]>(
		() => (isSpaceBoard && memberProjects && memberProjects.length > 0 ? memberProjects : [project]),
		[isSpaceBoard, memberProjects, project],
	);
	const projectById = useMemo(() => new Map(boardProjects.map((p) => [p.id, p])), [boardProjects]);
	// A card always renders with ITS OWN project — that is what makes every action
	// on a space board act on the right repository.
	const projectOfTask = useCallback((task: Task) => projectById.get(task.projectId) ?? project, [projectById, project]);
	const isCarousel = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const statusColors = useStatusColors();
	const agents = useAgents();
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-auto",
		taskSortOrder: "oldest-first",
		updateChannel: "stable",
	});
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus; mode?: "spawn" | "addAttempts" } | null>(null);
	const [dragFromStatus, setDragFromStatus] = useState<TaskStatus | null>(null);
	// Draft being edited: reopens the New Task popup prefilled from the card.
	const [editDraftTaskId, setEditDraftTaskId] = useState<string | null>(null);
	const [dragFromDraft, setDragFromDraft] = useState(false);
	const [dragFromCustomColumnId, setDragFromCustomColumnId] = useState<string | null>(null);
	// Whose repository the dragged card belongs to — a merged lane that project has
	// no column in must refuse it, visibly, before the drop.
	const [dragFromProjectId, setDragFromProjectId] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
	const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
	// Ref so drag handlers can check synchronously without waiting for state update
	const draggedColumnIdRef = useRef<string | null>(null);
	// Custom column just created from the board's "+" — opens directly in rename mode.
	const [autoEditColumnId, setAutoEditColumnId] = useState<string | null>(null);
	// Feature-discovery tip rotation (board context). Shared logic lives in the hook.
	const { tip: currentTip, tipState, applyTipState } = useTipRotation("board", globalSettings.tipsDisabled);
	// Keyed by the board SUBJECT: a space board has its own lane set, so it keeps
	// its own collapse memory instead of inheriting the anchor project's.
	const collapseState = useColumnCollapse(space ? `space-${space.id}` : project.id);

	const handleSetMoving = useCallback((taskId: string, isMoving: boolean) => {
		setMovingTaskIds((prev) => {
			const next = new Set(prev);
			if (isMoving) next.add(taskId);
			else next.delete(taskId);
			return next;
		});
	}, []);

	useEffect(() => {
		api.request.getGlobalSettings().then(setGlobalSettings).catch(() => {});
		// Follow the settings push, like the sidebar's useTaskSortOrder does: a sort
		// order changed in another window (or the remote browser) has to reorder this
		// board too, or the two surfaces disagree until the board remounts.
		function onSettingsUpdated(e: Event) {
			setGlobalSettings((e as CustomEvent<GlobalSettings>).detail);
		}
		window.addEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
		return () => window.removeEventListener("rpc:globalSettingsUpdated", onSettingsUpdated);
	}, []);

	// PR badge data for task cards: what each task already carries (sticky
	// prNumber/prUrl + prStatusCache), refreshed in-session by the `taskPrStatus`
	// push, plus a per-project branch->PR lookup so a PR whose identity was never
	// persisted still gets a badge. Virtual (Operations) boards have no git repo,
	// so they get no lookup instead of a doomed RPC every 60s.
	const gitProjectIds = useMemo(
		() => boardProjects.filter((p) => p.kind !== "virtual").map((p) => p.id),
		[boardProjects],
	);
	const knowsProject = useCallback((projectId: string) => projectById.has(projectId), [projectById]);
	const taskPrMap = useTaskPrBadges({ tasks, discoverProjectIds: gitProjectIds, knowsProject });

	// Global dragend listener to clear drag state
	useEffect(() => {
		function handleDragEnd() {
			setDragFromStatus(null);
			setDragFromCustomColumnId(null);
			setDragFromDraft(false);
			setDragFromProjectId(null);
		}
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	function handleDragStart(taskId: string) {
		const task = tasks.find((t) => t.id === taskId);
		if (task) {
			setDragFromStatus(task.status);
			setDragFromCustomColumnId(task.customColumnId ?? null);
			setDragFromDraft(task.draft === true);
			setDragFromProjectId(task.projectId);
		}
	}

	async function handleTaskDrop(taskId: string, targetStatus: TaskStatus) {
		setDragFromStatus(null);
		setDragFromCustomColumnId(null);
		setDragFromDraft(false);
		setDragFromProjectId(null);
		const task = tasks.find((t) => t.id === taskId);
		if (!task) return;

		// Columns already refuse a draft as a drop target; this is the last-resort
		// guard for a drop that still reaches the board (keyboard DnD, stale state).
		if (task.draft === true && targetStatus !== "todo") {
			toast.error(t("kanban.draftNotDroppable"), { taskId: task.id });
			return;
		}

		// If already in target status and no custom column, nothing to do
		if (task.status === targetStatus && !task.customColumnId) return;

		// todo → active: open LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(targetStatus) && !task.worktreePath) {
			setLaunchModal({ task, targetStatus });
			return;
		}

		const taskProject = projectOfTask(task);
		await moveTaskToStatus({
			task,
			project: taskProject,
			newStatus: targetStatus,
			dispatch,
			t,
			onOpenTask: () => {
				const openMode = getTaskOpenMode();
				navigate(openMode === "fullscreen"
					? { screen: "task", projectId: taskProject.id, taskId: task.id }
					: { screen: "project", projectId: taskProject.id, spaceId: space?.id, activeTaskId: task.id });
			},
			onMovingChange: (moving) => handleSetMoving(task.id, moving),
		});
	}

	// `laneId` is the LANE's id (the representative column). The id actually
	// written is the dropped card's own project's column inside that lane, which
	// is what keeps one gesture inside one repository.
	async function handleTaskDropToCustomColumn(taskId: string, laneId: string) {
		setDragFromStatus(null);
		setDragFromCustomColumnId(null);
		setDragFromDraft(false);
		setDragFromProjectId(null);
		const task = tasks.find((t) => t.id === taskId);
		if (!task) return;
		const lane = getOrderedColumns().find((slot) => laneKey(slot) === laneId);
		const customColumnId = lane ? laneColumnIdForProject(lane, task.projectId) : null;
		// The lane holds no column of this card's project — the column already
		// refuses the drop; this is the last-resort guard behind it.
		if (!customColumnId || task.customColumnId === customColumnId) return;
		if (task.draft === true) {
			toast.error(t("kanban.draftNotDroppable"), { taskId: task.id });
			return;
		}
		const taskProject = projectOfTask(task);

		// Optimistic update
		const optimisticTask = { ...task, customColumnId };
		dispatch({ type: "updateTask", task: optimisticTask });
		setMovingTaskIds((prev) => new Set(prev).add(task.id));

		try {
			const updated = await api.request.moveTaskToCustomColumn({
				taskId: task.id,
				projectId: taskProject.id,
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

	// Filter chips: one per label NAME across the board's projects, same merge rule
	// as the lanes. The `label:"…"` token already matches by name, so a merged chip
	// and the token it toggles mean the same thing.
	const projectLabels = useMemo<Label[]>(() => {
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
	const customColumns: CustomColumn[] = project.customColumns ?? [];
	// `customStatusLabels` is per project: two projects that renamed the same status
	// cannot be reconciled, and a merged label would misrepresent both. A space
	// board therefore shows dev3's canonical status names.
	const customStatusLabels = isSpaceBoard ? {} : (project.customStatusLabels ?? {});
	// Which LANE each project's custom column feeds. Built from the lane set alone
	// (occupancy only ever affects built-in visibility), so it is also the answer to
	// "does this card have a lane at all" — a card can never be excluded from the
	// status columns without a custom lane to land in.
	const laneIdByProjectColumn = useMemo(() => {
		const map = new Map<string, string>();
		for (const slot of getBoardColumns(boardProjects)) {
			if (slot.type !== "custom") continue;
			for (const member of slot.members) map.set(`${member.projectId}::${member.columnId}`, laneKey(slot));
		}
		return map;
	}, [boardProjects]);
	// A task belongs to a custom lane only if its own project still has that column.
	// A dangling customColumnId (its column was deleted, or a multi-instance write
	// referenced a column this instance never had) falls back to the task's
	// underlying status column so the task can never silently vanish from the board.
	const isInCustomColumn = (task: Task) =>
		!!task.customColumnId && laneIdByProjectColumn.has(`${task.projectId}::${task.customColumnId}`);

	// Facet resolver + funnel pool for the token-DSL filter. Custom-column tasks
	// report the column name as their canonical status value (mirrors where they
	// render), while still matching their underlying built-in status.
	const resolver: FacetResolver = useMemo(() => ({
		agents,
		labelsFor: (task) => (projectById.get(task.projectId)?.labels ?? []).filter((l) => task.labelIds?.includes(l.id)),
		statusValuesFor: (task) => {
			const ownColumns = projectById.get(task.projectId)?.customColumns ?? [];
			const col = task.customColumnId ? ownColumns.find((c) => c.id === task.customColumnId) : undefined;
			const label = customStatusLabels[task.status] || t(statusKey(task.status));
			return col ? [col.name, task.status, label] : [task.status, label];
		},
		priorityFor: (task) => task.priority ?? DEFAULT_PRIORITY,
		hasPortFor: (task) => (taskPorts.get(task.id)?.length ?? 0) > 0,
		isAttentionFor: isAttentionTask,
		prNumberFor: (task) => taskPrMap.get(task.id)?.number ?? null,
	}), [agents, projectById, customStatusLabels, taskPorts, taskPrMap, t]);

	// Priority leads the funnel; the board offers all five levels (P0…P4).
	const priorityCandidates = useMemo<FilterFunnelOption[]>(
		() => ALL_PRIORITIES.map((p) => ({ facet: "priority" as const, value: p, label: `${p} — ${t(PRIORITY_NAME_KEYS[p])}` })),
		[t],
	);
	// One entry per custom LANE — merged by name across the board's projects, so a
	// space board offers "On hold" once however many projects have it.
	const boardCustomColumns = useMemo<CustomColumn[]>(() => {
		if (!isSpaceBoard) return customColumns;
		const byName = new Map<string, CustomColumn>();
		for (const member of boardProjects) {
			for (const col of member.customColumns ?? []) {
				const key = normalizeLaneName(col.name);
				if (!byName.has(key)) byName.set(key, col);
			}
		}
		return [...byName.values()];
	}, [isSpaceBoard, boardProjects, customColumns]);
	// The board offers every board status (plus custom columns) in the funnel.
	const statusCandidates = useMemo<FilterFunnelOption[]>(() => [
		...ALL_STATUSES.map((s) => ({ facet: "status" as const, value: s, label: customStatusLabels[s] || t(statusKey(s)) })),
		...boardCustomColumns.map((c) => ({ facet: "status" as const, value: c.name, label: c.name, color: c.color })),
	], [customStatusLabels, boardCustomColumns, t]);

	const filterGroups = useMemo(
		() => buildFilterGroups(tasks, resolver, {
			priorityCandidates,
			statusCandidates,
			flagLabels: { attention: t("filter.flag.attention"), port: t("filter.flag.port"), home: t("spaces.homeGroup") },
		}),
		[tasks, resolver, priorityCandidates, statusCandidates, t],
	);

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
				toast.error(t("kanban.failedReorderColumns", { error: String(err) }), { projectId: project.id });
			});
			setAutoEditColumnId(column.id);
		} catch (err) {
			toast.error(t("customColumns.failedCreate", { error: String(err) }), { projectId: project.id });
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
			toast.error(t("customColumns.failedUpdate", { error: String(err) }), { projectId: project.id });
		}
	}

	// Apply the token-DSL filter (facets + free text) — the search string is the
	// single source of truth; the old separate `activeFilters` state is gone.
	let displayTasks = tasks;
	if (searchQuery.trim()) {
		displayTasks = displayTasks.filter((task) => matchesTaskQuery(task, searchQuery, taskQueryContext(task, resolver)));
	}

	// Built-in column tasks (exclude tasks in an existing custom column; tasks
	// with a dangling customColumnId fall back here into their status column,
	// and an unrecognized status falls back to To Do — see partitionTasksByStatus).
	const tasksByStatus = partitionTasksByStatus(displayTasks, isInCustomColumn);

	// Sort tasks within each built-in column for variant grouping
	for (const status of ALL_STATUSES) {
		const columnTasks = tasksByStatus.get(status);
		if (columnTasks && columnTasks.length > 1) {
			tasksByStatus.set(status, sortTasksForColumn(columnTasks, globalSettings.taskSortOrder, status));
		}
	}

	// Returns all columns in their effective display order (delegates to the
	// shared getBoardColumns). Occupancy is computed from the FULL task list, not
	// the filtered one: a search filter must never hide a column out from under
	// the cards it holds. "Your Review" stays even on virtual boards: a finished
	// ops task is handed back via review-by-user, so hiding it would drop the
	// task off the board.
	function getOrderedColumns(): ColumnSlot[] {
		const occupiedStatuses = new Set<TaskStatus>();
		for (const task of tasks) {
			if (!isInCustomColumn(task)) occupiedStatuses.add(task.status);
		}
		return getBoardColumns(boardProjects, { occupiedStatuses });
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
			toast.error(t("kanban.failedReorderColumns", { error: String(err) }), { projectId: project.id });
		});
	}

	function handleColumnDragEnd() {
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
	}

	// Custom lane tasks, keyed by LANE (not by one project's column id): a merged
	// lane collects every member project's same-named column into one list.
	const tasksByCustomColumn = new Map<string, Task[]>();
	for (const slot of getOrderedColumns()) {
		if (slot.type === "custom") tasksByCustomColumn.set(laneKey(slot), []);
	}
	for (const task of displayTasks) {
		if (!isInCustomColumn(task)) continue;
		const laneId = laneIdByProjectColumn.get(`${task.projectId}::${task.customColumnId}`);
		if (laneId) tasksByCustomColumn.get(laneId)?.push(task);
	}
	// Custom columns get the same ordering as built-in ones; they used to render in
	// raw task order, which put a P4 above a P3.
	for (const [colId, colTasks] of tasksByCustomColumn) {
		tasksByCustomColumn.set(colId, sortTasksForColumn(colTasks, globalSettings.taskSortOrder));
	}

	// Find the first column with <2 tasks for the tip card (only one tip across the board)
	// Exclude collapsed columns from tip placement
	const tipColumnId: string | null = useMemo(() => {
		if (!currentTip) return null;
		// A board with no tasks at all belongs to someone who has not started yet:
		// the To Do column's own empty state has to explain the first task, and a
		// tip about hovering a task card is noise to a user who has no cards.
		if (tasks.length === 0) return null;
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
	}, [currentTip, displayTasks, tasks.length, collapseState]);

	// Resolved from the live task list, so the popup closes by itself if the draft
	// is promoted or deleted from somewhere else.
	const editDraftTask = editDraftTaskId
		? tasks.find((task) => task.id === editDraftTaskId && task.draft === true) ?? null
		: null;

	const orderedColumns = getOrderedColumns();
	const handleTipChanged = applyTipState;

	// Add-column affordance for the desktop board (issue #222). Rendered just before
	// the Completed column so it stays in the active-lifecycle region of the board.
	const addColumnButton = (
		<button
			key="add-column"
			type="button"
			onClick={handleCreateCustomColumn}
			className="group/addcol flex-shrink-0 self-stretch w-11 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-edge text-fg-3 hover:text-accent hover:border-accent/40 hover:bg-accent/5 transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.96]"
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
		boardEmpty: tasks.length === 0,
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
		dragFromStatus,
		dragFromCustomColumnId,
		dragFromDraft,
		// A card carries its project's name only where there is more than one
		// project on screen — on a project board it would be noise.
		projectForTask: isSpaceBoard ? projectOfTask : undefined,
		onEditDraft: (task: Task) => setEditDraftTaskId(task.id),
		onDragStart: handleDragStart,
		bellCounts,
		bellReasons,
		taskPorts,
		taskDevServers,
		taskResourceUsage,
		activeTaskId,
		movingTaskIds,
		siblingMap,
		onSetMoving: handleSetMoving,
		taskPrMap,
		onOpenUnresolvedComments,
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
					onColumnDrop={isSpaceBoard ? undefined : (side) => handleColumnDrop(slot.status, side)}
					tip={tipColumnId === slot.status ? currentTip : undefined}
					onTipChanged={handleTipChanged}
					tipState={tipState ?? undefined}
					collapsed={full ? false : collapseState.isCollapsed(colId)}
					onCollapseToggle={full ? undefined : () => collapseState.toggle(colId)}
					collapseDragHandlers={full ? undefined : collapseState.dragExpandHandlers(colId)}
					onRenameColumn={isSpaceBoard ? undefined : (name) => handleRenameBuiltinColumn(slot.status, name)}
					fullWidth={full}
					{...commonProps}
				/>
			);
		}
		const col = slot.col;
		const laneId = laneKey(slot);
		// Reordering, renaming and deleting a lane belong to ONE project's board:
		// a merged lane stands for several projects' columns and has no single
		// order or name to write. Cards still drag freely.
		const laneIsMerged = isSpaceBoard;
		return (
			<KanbanColumn
				key={laneId}
				status="todo"
				label={col.name}
				mergedProjectCount={slot.members.length > 1 ? slot.members.length : undefined}
				laneRefusesDrag={dragFromProjectId !== null && !laneAcceptsProject(slot, dragFromProjectId)}
				tasks={tasksByCustomColumn.get(laneId) || []}
				onTaskDropToCustomColumn={handleTaskDropToCustomColumn}
				isCustomColumn
				customColumnId={laneId}
				colorOverride={col.color}
				isDraggedColumn={draggedColumnId === laneId}
				onColumnDragStart={laneIsMerged ? undefined : () => handleColumnDragStart(laneId)}
				onColumnDragEnd={laneIsMerged ? undefined : handleColumnDragEnd}
				onColumnDrop={laneIsMerged ? undefined : (side) => handleColumnDrop(laneId, side)}
				onRenameColumn={laneIsMerged ? undefined : (name) => handleRenameCustomColumn(laneId, name ?? "")}
				autoStartEditing={autoEditColumnId === laneId}
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
				.filter((slot) => !collapseState.isUserCollapsed(laneKey(slot)))
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
								id: laneKey(slot),
								label: slot.col.name,
								color: slot.col.color ?? statusColors.todo,
								count: tasksByCustomColumn.get(laneKey(slot))?.length ?? 0,
								element: renderColumnElement(slot, true),
							},
				)
		: [];
	const initialColumnId = carouselColumns.find((column) => column.id === "user-questions" && column.count > 0)?.id
		?? carouselColumns.find((column) => column.id === "review-by-user" && column.count > 0)?.id;

	return (
		<>
			<LabelFilterBar
				labels={projectLabels}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
				filterGroups={filterGroups}
				disableGlobalFindShortcut={disableGlobalFindShortcut}
			/>
			{isCarousel ? (
				<MobileBoardCarousel columns={carouselColumns} initialColumnId={initialColumnId} />
			) : (
				<div className="flex-1 min-h-0 flex gap-5 px-6 pb-6 pt-2 overflow-x-auto overflow-y-hidden kanban-scroll select-none">
					{(() => {
						// Add-column affordance (issue #222): a slim dashed ghost strip that
						// reuses the board's "+" idiom — no toolbar button. It sits right
						// before the Completed column (the end-of-lifecycle boundary), not at
						// the very end past Cancelled.
						const hasCompleted = orderedColumns.some((s) => s.type === "builtin" && s.status === "completed");
						return orderedColumns.flatMap((slot) => {
							const el = renderColumnElement(slot, false);
							const beforeCompleted = !isSpaceBoard && slot.type === "builtin" && slot.status === "completed";
							return beforeCompleted ? [addColumnButton, el] : [el];
							// Defensive fallback handled below when Completed is somehow absent.
						}).concat(hasCompleted || isSpaceBoard ? [] : [addColumnButton]);
					})()}
				</div>
			)}

			{editDraftTask && (
				<CreateTaskModal
					project={project}
					dispatch={dispatch}
					draftTask={editDraftTask}
					onClose={() => setEditDraftTaskId(null)}
					onCreateAndRun={(task) => {
						setEditDraftTaskId(null);
						setLaunchModal({ task, targetStatus: "in-progress" });
					}}
				/>
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
