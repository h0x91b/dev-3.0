import { useState, useEffect, useRef, type Dispatch } from "react";
import type { CodingAgent, GlobalSettings, Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import { api } from "../rpc";
import KanbanColumn from "./KanbanColumn";
import CreateTaskModal from "./CreateTaskModal";
import LaunchVariantsModal from "./LaunchVariantsModal";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
}

function sortTasksForColumn(
	tasks: Task[],
	dropPosition: "top" | "bottom",
	moveOrderMap: Map<string, number>,
): Task[] {
	return [...tasks].sort((a, b) => {
		// Move order takes top priority when dropPosition is "top"
		if (dropPosition === "top") {
			const aOrder = moveOrderMap.get(a.id) ?? 0;
			const bOrder = moveOrderMap.get(b.id) ?? 0;
			if (aOrder !== bOrder) return bOrder - aOrder;
		}
		// Group by groupId: tasks with same groupId stay together
		const aGroup = a.groupId ?? "";
		const bGroup = b.groupId ?? "";
		if (aGroup !== bGroup) {
			if (!aGroup) return 1;
			if (!bGroup) return -1;
			return aGroup < bGroup ? -1 : 1;
		}
		// Within same group, sort by variantIndex
		if (a.groupId && b.groupId) {
			return (a.variantIndex ?? 0) - (b.variantIndex ?? 0);
		}
		// Ungrouped: sort by position preference
		if (dropPosition === "top") {
			// Fallback: movedAt from task (persisted across reloads)
			if (a.movedAt && b.movedAt) return b.movedAt > a.movedAt ? 1 : -1;
			if (a.movedAt) return -1;
			if (b.movedAt) return 1;
		}
		return a.createdAt < b.createdAt ? -1 : 1;
	});
}

function KanbanBoard({ project, tasks, dispatch, navigate }: KanbanBoardProps) {
	const t = useT();
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const [globalSettings, setGlobalSettings] = useState<GlobalSettings>({
		defaultAgentId: "builtin-claude",
		defaultConfigId: "claude-default",
		taskDropPosition: "top",
	});
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus } | null>(null);
	const [dragFromStatus, setDragFromStatus] = useState<TaskStatus | null>(null);
	const [moveOrderMap, setMoveOrderMap] = useState<Map<string, number>>(new Map());
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

		// Direct move for all other transitions
		try {
			const updated = await api.request.moveTask({
				taskId: task.id,
				projectId: project.id,
				newStatus: targetStatus,
			});
			dispatch({ type: "updateTask", task: updated });
			recordMove(task.id);
		} catch (err) {
			alert(t("task.failedMove", { error: String(err) }));
		}
	}

	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of tasks) {
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
			<div className="flex-1 min-h-0 flex gap-5 p-6 pb-12 overflow-x-auto overflow-y-hidden">
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
					/>
				))}
			</div>

			{showCreateModal && (
				<CreateTaskModal
					project={project}
					dispatch={dispatch}
					onClose={() => setShowCreateModal(false)}
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
