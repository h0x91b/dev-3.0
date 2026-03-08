import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import type { CodingAgent, CustomColumn, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES } from "../../shared/types";

// Built-in statuses before custom columns
const STATUSES_BEFORE_CUSTOM: TaskStatus[] = ["todo", "in-progress", "user-questions", "review-by-ai", "review-by-user"];
// Built-in statuses after custom columns
const STATUSES_AFTER_CUSTOM: TaskStatus[] = ["completed", "cancelled"];
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import { api } from "../rpc";
import { trackEvent } from "../analytics";
import KanbanColumn from "./KanbanColumn";
import CreateTaskModal from "./CreateTaskModal";
import LaunchVariantsModal from "./LaunchVariantsModal";
import { sortTasksForColumn } from "./sortTasks";
import LabelFilterBar from "./LabelFilterBar";
import { matchesSearchQuery } from "../utils/taskSearch";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	activeTaskId?: string;
	onSwitchToSidebar?: () => void;
}

function KanbanBoard({ project, tasks, dispatch, navigate, bellCounts, activeTaskId, onSwitchToSidebar }: KanbanBoardProps) {
	const t = useT();
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskDropPosition: "top",
		updateChannel: "stable",
	});
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus } | null>(null);
	const [dragFromStatus, setDragFromStatus] = useState<TaskStatus | null>(null);
	const [dragFromCustomColumnId, setDragFromCustomColumnId] = useState<string | null>(null);
	const [moveOrderMap, setMoveOrderMap] = useState<Map<string, number>>(new Map());
	const [activeFilters, setActiveFilters] = useState<string[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
	const moveCounterRef = useRef(0);
	const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null);
	// Ref so drag handlers can check synchronously without waiting for state update
	const draggedColumnIdRef = useRef<string | null>(null);

	const handleSetMoving = useCallback((taskId: string, isMoving: boolean) => {
		setMovingTaskIds((prev) => {
			const next = new Set(prev);
			if (isMoving) next.add(taskId);
			else next.delete(taskId);
			return next;
		});
	}, []);

	// Cmd+N — open create task modal (capture phase to intercept before terminal)
	const handleCmdN = useCallback((e: KeyboardEvent) => {
		if (!((e.metaKey || e.ctrlKey) && e.key === "n")) return;
		if (showCreateModal || launchModal !== null) return;
		e.preventDefault();
		e.stopPropagation();
		setShowCreateModal(true);
	}, [showCreateModal, launchModal]);

	useEffect(() => {
		window.addEventListener("keydown", handleCmdN, { capture: true });
		return () => window.removeEventListener("keydown", handleCmdN, { capture: true });
	}, [handleCmdN]);

	function recordMove(taskId: string) {
		moveCounterRef.current += 1;
		setMoveOrderMap((prev) => new Map(prev).set(taskId, moveCounterRef.current));
	}

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
		api.request.getGlobalSettings().then(setGlobalSettings).catch(() => {});
	}, []);

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

		// Warn before completing/cancelling with unpushed changes
		if (
			task.worktreePath &&
			(targetStatus === "completed" || targetStatus === "cancelled")
		) {
			const proceed = await confirmTaskCompletion(task, project, targetStatus, t);
			if (!proceed) return;
		}

		const fromStatus = task.status;

		// Optimistic update: move card immediately and clear customColumnId
		const optimisticTask = { ...task, status: targetStatus, customColumnId: null };
		dispatch({ type: "updateTask", task: optimisticTask });
		if (targetStatus === "completed" || targetStatus === "cancelled") {
			dispatch({ type: "clearBell", taskId: task.id });
		}
		recordMove(task.id);
		setMovingTaskIds((prev) => new Set(prev).add(task.id));

		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: targetStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			trackEvent("task_moved", { from_status: fromStatus, to_status: targetStatus });
		} catch (err) {
			// Revert optimistic update on failure
			dispatch({ type: "updateTask", task });
			alert(t("task.failedMove", { error: String(err) }));
		} finally {
			setMovingTaskIds((prev) => {
				const next = new Set(prev);
				next.delete(task.id);
				return next;
			});
		}
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
			alert(t("task.failedMove", { error: String(err) }));
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

	// Apply label filters + search
	let displayTasks = tasks;
	if (activeFilters.length > 0) {
		displayTasks = displayTasks.filter((t) => activeFilters.some((id) => t.labelIds?.includes(id)));
	}
	if (searchQuery.trim()) {
		displayTasks = displayTasks.filter((t) => matchesSearchQuery(t, searchQuery));
	}

	// Built-in column tasks (exclude tasks in custom columns)
	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of displayTasks) {
		if (!task.customColumnId) {
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

	function handleColumnDragStart(colId: string) {
		draggedColumnIdRef.current = colId;
		setDraggedColumnId(colId);
	}

	// Called by KanbanColumn when a column is dragged over it (left/right half)
	function handleColumnDrop(targetColId: string, side: "before" | "after") {
		const srcColId = draggedColumnIdRef.current;
		if (!srcColId || srcColId === targetColId) return;
		const cols = [...customColumns];
		const fromIndex = cols.findIndex((c) => c.id === srcColId);
		const toIndex = cols.findIndex((c) => c.id === targetColId);
		if (fromIndex === -1 || toIndex === -1) return;
		// Compute insert position
		let insertAt = side === "after" ? toIndex + 1 : toIndex;
		if (fromIndex < insertAt) insertAt -= 1; // account for removal
		const [moved] = cols.splice(fromIndex, 1);
		cols.splice(insertAt, 0, moved);
		draggedColumnIdRef.current = null;
		setDraggedColumnId(null);
		const reordered = cols.map((c) => c.id);
		dispatch({ type: "updateProject", project: { ...project, customColumns: cols } });
		api.request.reorderCustomColumns({ projectId: project.id, columnIds: reordered }).catch((err) => {
			alert(`Failed to reorder columns: ${String(err)}`);
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
		if (task.customColumnId) {
			tasksByCustomColumn.get(task.customColumnId)?.push(task);
		}
	}

	return (
		<>
			{onSwitchToSidebar && (
				<div className="flex items-center px-3 pt-2">
					<button
						onClick={onSwitchToSidebar}
						className="text-[0.625rem] text-fg-muted hover:text-accent transition-colors px-1.5 py-0.5 rounded hover:bg-fg/5 flex items-center gap-1"
						title={t("sidebar.switchToSidebar")}
					>
						{/* Nerd Font: fa-list (U+F03A) */}
						<span className="text-sm font-mono leading-none">{"\uF03A"}</span>
						<span>{t("sidebar.switchToSidebar")}</span>
					</button>
				</div>
			)}
			<LabelFilterBar
				labels={projectLabels}
				activeFilters={activeFilters}
				onToggle={(id) =>
					setActiveFilters((prev) =>
						prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id],
					)
				}
				onClear={() => setActiveFilters([])}
				searchQuery={searchQuery}
				onSearchChange={setSearchQuery}
			/>
			<div className="flex-1 min-h-0 flex gap-5 p-6 pb-8 overflow-x-scroll overflow-y-hidden kanban-scroll">
				{STATUSES_BEFORE_CUSTOM.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						label={t(statusKey(status))}
						tasks={tasksByStatus.get(status) || []}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
						onAddTask={() => setShowCreateModal(true)}
						agents={agents}
						onLaunchVariants={(task, targetStatus) =>
							setLaunchModal({ task, targetStatus })
						}
						onTaskDrop={handleTaskDrop}
						onReorderTask={handleReorderTask}
						dragFromStatus={dragFromStatus}
						dragFromCustomColumnId={dragFromCustomColumnId}
						onDragStart={handleDragStart}
						onTaskMoved={recordMove}
						bellCounts={bellCounts}
						activeTaskId={activeTaskId}
						draggedTaskId={draggedTaskId}
						movingTaskIds={movingTaskIds}
						onSetMoving={handleSetMoving}
						siblingMap={siblingMap}
					/>
				))}

				{/* Custom columns — each column is also a column-reorder drop target (left=before, right=after) */}
				{customColumns.map((col) => (
					<KanbanColumn
						key={col.id}
						status="todo"
						label={col.name}
						tasks={tasksByCustomColumn.get(col.id) || []}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
						onAddTask={() => setShowCreateModal(true)}
						agents={agents}
						onLaunchVariants={(task, targetStatus) =>
							setLaunchModal({ task, targetStatus })
						}
						onTaskDrop={handleTaskDrop}
						onTaskDropToCustomColumn={handleTaskDropToCustomColumn}
						onReorderTask={handleReorderTask}
						dragFromStatus={dragFromStatus}
						dragFromCustomColumnId={dragFromCustomColumnId}
						onDragStart={handleDragStart}
						onTaskMoved={recordMove}
						bellCounts={bellCounts}
						activeTaskId={activeTaskId}
						draggedTaskId={draggedTaskId}
						movingTaskIds={movingTaskIds}
						siblingMap={siblingMap}
						isCustomColumn
						customColumnId={col.id}
						colorOverride={col.color}
						isDraggedColumn={draggedColumnId === col.id}
						onColumnDragStart={() => handleColumnDragStart(col.id)}
						onColumnDragEnd={handleColumnDragEnd}
						onColumnDrop={(side) => handleColumnDrop(col.id, side)}
					/>
				))}

				{STATUSES_AFTER_CUSTOM.map((status) => (
					<KanbanColumn
						key={status}
						status={status}
						label={t(statusKey(status))}
						tasks={tasksByStatus.get(status) || []}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
						onAddTask={() => setShowCreateModal(true)}
						agents={agents}
						onLaunchVariants={(task, targetStatus) =>
							setLaunchModal({ task, targetStatus })
						}
						onTaskDrop={handleTaskDrop}
						onReorderTask={handleReorderTask}
						dragFromStatus={dragFromStatus}
						dragFromCustomColumnId={dragFromCustomColumnId}
						onDragStart={handleDragStart}
						onTaskMoved={recordMove}
						bellCounts={bellCounts}
						activeTaskId={activeTaskId}
						draggedTaskId={draggedTaskId}
						movingTaskIds={movingTaskIds}
						siblingMap={siblingMap}
					/>
				))}
			</div>

			{showCreateModal && (
				<CreateTaskModal
					project={project}
					dispatch={dispatch}
					onClose={() => setShowCreateModal(false)}
					onCreateAndRun={(task) => {
						setShowCreateModal(false);
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
				/>
			)}
		</>
	);
}

export default KanbanBoard;
