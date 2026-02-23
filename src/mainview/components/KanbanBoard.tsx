import { useState, useEffect, type Dispatch } from "react";
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

function sortTasksForColumn(tasks: Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		// Group by groupId: tasks with same groupId stay together
		const aGroup = a.groupId ?? "";
		const bGroup = b.groupId ?? "";
		if (aGroup !== bGroup) {
			// Ungrouped tasks sort by createdAt
			if (!aGroup) return 1;
			if (!bGroup) return -1;
			return aGroup < bGroup ? -1 : 1;
		}
		// Within same group, sort by variantIndex
		if (a.groupId && b.groupId) {
			return (a.variantIndex ?? 0) - (b.variantIndex ?? 0);
		}
		// Ungrouped: sort by createdAt
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
	});
	const [launchModal, setLaunchModal] = useState<{ task: Task; targetStatus: TaskStatus } | null>(null);
	const [dragFromStatus, setDragFromStatus] = useState<TaskStatus | null>(null);

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
			tasksByStatus.set(status, sortTasksForColumn(columnTasks));
		}
	}

	return (
		<>
			<div className="flex gap-3 p-5 h-full min-h-0 overflow-x-auto overflow-y-hidden">
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
