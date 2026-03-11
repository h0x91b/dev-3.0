import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import type { CodingAgent, CustomColumn, GlobalSettings, PortInfo, Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES } from "../../shared/types";

// Default built-in column order (custom columns can be freely interspersed)
const DEFAULT_BEFORE_CUSTOM: TaskStatus[] = ["todo", "in-progress", "user-questions", "review-by-ai", "review-by-user"];
const DEFAULT_AFTER_CUSTOM: TaskStatus[] = ["review-by-colleague", "completed", "cancelled"];
const ALL_BUILTIN: TaskStatus[] = [...DEFAULT_BEFORE_CUSTOM, ...DEFAULT_AFTER_CUSTOM];

type ColumnSlot =
	| { type: "builtin"; status: TaskStatus }
	| { type: "custom"; col: CustomColumn };
import type { AppAction, Route } from "../state";
import { useT, statusKey, statusDescKey } from "../i18n";
import { api } from "../rpc";
import { trackEvent } from "../analytics";
import KanbanColumn from "./KanbanColumn";
import CreateTaskModal from "./CreateTaskModal";
import LaunchVariantsModal from "./LaunchVariantsModal";
import { sortTasksForColumn } from "./sortTasks";
import LabelFilterBar from "./LabelFilterBar";
import { matchesSearchQuery } from "../utils/taskSearch";
import { confirmTaskCompletion } from "../utils/confirmTaskCompletion";
import { getCurrentTip } from "../tips";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
	activeTaskId?: string;
	onSwitchToSidebar?: () => void;
}

function KanbanBoard({ project, tasks, dispatch, navigate, bellCounts, taskPorts, activeTaskId, onSwitchToSidebar }: KanbanBoardProps) {
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
	const [tipRevision, setTipRevision] = useState(0);
	const currentTip = useMemo(() => getCurrentTip(), [tipRevision]);

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

	// Returns all columns in their effective display order, respecting project.columnOrder
	function getOrderedColumns(): ColumnSlot[] {
		const cols = customColumns;
		const peerReviewEnabled = project.peerReviewEnabled !== false;
		// Hide AI Review column unless it has tasks (feature not yet implemented)
		const aiReviewHasItems = tasks.some((t) => t.status === "review-by-ai" && !t.customColumnId);
		const shouldHide = (s: TaskStatus) =>
			(s === "review-by-colleague" && !peerReviewEnabled) ||
			(s === "review-by-ai" && !aiReviewHasItems);
		const filterBuiltin = (statuses: TaskStatus[]) =>
			statuses.filter((s) => !shouldHide(s));
		if (!project.columnOrder || project.columnOrder.length === 0) {
			return [
				...filterBuiltin(DEFAULT_BEFORE_CUSTOM).map((s) => ({ type: "builtin" as const, status: s })),
				...cols.map((c) => ({ type: "custom" as const, col: c })),
				...filterBuiltin(DEFAULT_AFTER_CUSTOM).map((s) => ({ type: "builtin" as const, status: s })),
			];
		}
		const result: ColumnSlot[] = [];
		const used = new Set<string>();
		for (const id of project.columnOrder) {
			if ((ALL_BUILTIN as string[]).includes(id) && shouldHide(id as TaskStatus)) { used.add(id); continue; }
			if ((ALL_BUILTIN as string[]).includes(id)) {
				result.push({ type: "builtin", status: id as TaskStatus });
				used.add(id);
			} else {
				const col = cols.find((c) => c.id === id);
				if (col) { result.push({ type: "custom", col }); used.add(id); }
			}
		}
		// review-by-colleague: if missing from stored order, insert right before "completed"
		// (not at the tail) so it stays in a logical position for existing users.
		if (!used.has("review-by-colleague") && !shouldHide("review-by-colleague")) {
			const completedIdx = result.findIndex((c) => c.type === "builtin" && c.status === "completed");
			const slot = { type: "builtin" as const, status: "review-by-colleague" as TaskStatus };
			if (completedIdx !== -1) {
				result.splice(completedIdx, 0, slot);
			} else {
				result.push(slot);
			}
			used.add("review-by-colleague");
		}
		// Append anything else missing (new built-ins, or new custom cols)
		for (const s of ALL_BUILTIN) {
			if (!used.has(s) && !shouldHide(s)) {
				result.push({ type: "builtin", status: s });
			}
		}
		for (const col of cols) { if (!used.has(col.id)) result.push({ type: "custom", col }); }
		return result;
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

	// Find the first column with <2 tasks for the tip card (only one tip across the board)
	const tipColumnId: string | null = useMemo(() => {
		if (!currentTip) return null;
		const orderedCols = getOrderedColumns();
		for (const slot of orderedCols) {
			if (slot.type === "builtin") {
				const count = tasksByStatus.get(slot.status)?.length ?? 0;
				if (count < 3) return slot.status;
			} else {
				const count = tasksByCustomColumn.get(slot.col.id)?.length ?? 0;
				if (count < 3) return slot.col.id;
			}
		}
		return null;
	}, [currentTip, displayTasks]);

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
			<div className="flex-1 min-h-0 flex gap-5 p-6 overflow-x-scroll overflow-y-hidden kanban-scroll">
				{getOrderedColumns().map((slot) => {
					const handleTipDismiss = () => setTipRevision((r) => r + 1);
					const commonProps = {
						project,
						dispatch,
						navigate,
						onAddTask: () => setShowCreateModal(true),
						agents,
						onLaunchVariants: (task: Task, targetStatus: TaskStatus) =>
							setLaunchModal({ task, targetStatus }),
						onTaskDrop: handleTaskDrop,
						onReorderTask: handleReorderTask,
						dragFromStatus,
						dragFromCustomColumnId,
						onDragStart: handleDragStart,
						onTaskMoved: recordMove,
						bellCounts,
						taskPorts,
						activeTaskId,
						draggedTaskId,
						movingTaskIds,
						siblingMap,
						onSetMoving: handleSetMoving,
					};
					if (slot.type === "builtin") {
						return (
							<KanbanColumn
								key={slot.status}
								status={slot.status}
								label={t(statusKey(slot.status))}
								description={t(statusDescKey(slot.status))}
								tasks={tasksByStatus.get(slot.status) || []}
								onColumnDrop={(side) => handleColumnDrop(slot.status, side)}
								tip={tipColumnId === slot.status ? currentTip : undefined}
								onTipDismiss={handleTipDismiss}
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
							tip={tipColumnId === col.id ? currentTip : undefined}
							onTipDismiss={handleTipDismiss}
							{...commonProps}
						/>
					);
				})}
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
