import { useState, useEffect, useRef, type Dispatch } from "react";
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
	const moveCounterRef = useRef(0);

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
		}
		window.addEventListener("dragend", handleDragEnd);
		return () => window.removeEventListener("dragend", handleDragEnd);
	}, []);

	function handleDragStart(taskId: string) {
		const task = tasks.find((t) => t.id === taskId);
		if (task) setDragFromStatus(task.status);
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
			ACTIVE_STATUSES.includes(task.status) &&
			(targetStatus === "completed" || targetStatus === "cancelled")
		) {
			const proceed = await confirmTaskCompletion(task, project, targetStatus, t);
			if (!proceed) return;
		}

		const fromStatus = task.status;
		// Direct move for all other transitions
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: targetStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			recordMove(task.id);
			trackEvent("task_moved", { from_status: fromStatus, to_status: targetStatus });
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
	}

	const projectLabels = project.labels ?? [];

	// Apply label filters
	const displayTasks =
		activeFilters.length > 0
			? tasks.filter((t) => activeFilters.some((id) => t.labelIds?.includes(id)))
			: tasks;

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
			/>
			<div className="flex-1 min-h-0 flex gap-5 p-6 pb-4 overflow-x-scroll overflow-y-hidden kanban-scroll">
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
						dragFromStatus={dragFromStatus}
						onDragStart={handleDragStart}
					onTaskMoved={recordMove}
						bellCounts={bellCounts}
					activeTaskId={activeTaskId}
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
