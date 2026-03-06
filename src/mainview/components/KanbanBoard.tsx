import { useState, useEffect, useRef, useCallback, useMemo, type Dispatch } from "react";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES } from "../../shared/types";
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
}

function KanbanBoard({ project, tasks, dispatch, navigate, bellCounts, activeTaskId }: KanbanBoardProps) {
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
	const [moveOrderMap, setMoveOrderMap] = useState<Map<string, number>>(new Map());
	const [activeFilters, setActiveFilters] = useState<string[]>([]);
	const [searchQuery, setSearchQuery] = useState("");
	const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set());
	const moveCounterRef = useRef(0);

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
			setDraggedTaskId(taskId);
		}
	}

	async function handleTaskDrop(taskId: string, targetStatus: TaskStatus) {
		setDragFromStatus(null);
		const task = tasks.find((t) => t.id === taskId);
		if (!task || task.status === targetStatus) return;

		// todo → active: open LaunchVariantsModal
		if (task.status === "todo" && ACTIVE_STATUSES.includes(targetStatus)) {
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

		// Optimistic update: move card to target column immediately and mark as moving
		const optimisticTask = { ...task, status: targetStatus };
		dispatch({ type: "updateTask", task: optimisticTask });
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

	// Apply label filters + search
	let displayTasks = tasks;
	if (activeFilters.length > 0) {
		displayTasks = displayTasks.filter((t) => activeFilters.some((id) => t.labelIds?.includes(id)));
	}
	if (searchQuery.trim()) {
		displayTasks = displayTasks.filter((t) => matchesSearchQuery(t, searchQuery));
	}

	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of displayTasks) {
		tasksByStatus.get(task.status)?.push(task);
	}

	// Sort tasks within each column for variant grouping
	for (const status of ALL_STATUSES) {
		const columnTasks = tasksByStatus.get(status);
		if (columnTasks && columnTasks.length > 1) {
			tasksByStatus.set(status, sortTasksForColumn(columnTasks, globalSettings.taskDropPosition, moveOrderMap));
		}
	}

	return (
		<>
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
				{ALL_STATUSES.map((status) => (
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
