import { useState, useEffect, useRef, type Dispatch } from "react";
import type { CodingAgent, GlobalSettings, Label, Project, Task, TaskStatus } from "../../shared/types";
import { ALL_STATUSES, ACTIVE_STATUSES } from "../../shared/types";
import LabelBadge from "./LabelBadge";
import LabelManager from "./LabelManager";
import type { AppAction, Route } from "../state";
import { useT, statusKey } from "../i18n";
import { api } from "../rpc";
import { trackEvent } from "../analytics";
import KanbanColumn from "./KanbanColumn";
import CreateTaskModal from "./CreateTaskModal";
import LaunchVariantsModal from "./LaunchVariantsModal";
import { sortTasksForColumn } from "./sortTasks";

interface KanbanBoardProps {
	project: Project;
	tasks: Task[];
	labels: Label[];
	activeLabelFilter: string[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
}

function KanbanBoard({ project, tasks, labels, activeLabelFilter, dispatch, navigate, bellCounts }: KanbanBoardProps) {
	const t = useT();
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [labelManagerOpen, setLabelManagerOpen] = useState(false);
	const labelManagerBtnRef = useRef<HTMLButtonElement>(null);
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

	// Apply label filter (OR logic)
	const filteredTasks = activeLabelFilter.length > 0
		? tasks.filter((task) => task.labelIds.some((id) => activeLabelFilter.includes(id)))
		: tasks;

	const tasksByStatus = new Map<TaskStatus, Task[]>();
	for (const status of ALL_STATUSES) {
		tasksByStatus.set(status, []);
	}
	for (const task of filteredTasks) {
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
			{/* Label filter bar */}
			{labels.length > 0 && (
				<div className="flex items-center gap-2 px-6 pt-3 pb-0 flex-shrink-0">
					<button
						ref={labelManagerBtnRef}
						onClick={() => setLabelManagerOpen(!labelManagerOpen)}
						className="flex items-center gap-1.5 text-xs text-fg-3 hover:text-fg-2 px-2 py-1 rounded-lg hover:bg-fg/5 transition-colors"
						title={t("labels.manage")}
					>
						<svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
						</svg>
						{t("labels.title")}
					</button>
					<div className="w-px h-4 bg-edge" />
					{labels.map((label) => (
						<LabelBadge
							key={label.id}
							label={label}
							onClick={() => dispatch({ type: "toggleLabelFilter", labelId: label.id })}
							active={activeLabelFilter.includes(label.id)}
							size="md"
						/>
					))}
					{activeLabelFilter.length > 0 && (
						<button
							onClick={() => dispatch({ type: "clearLabelFilter" })}
							className="text-xs text-fg-muted hover:text-fg-2 px-1.5 py-0.5 rounded hover:bg-fg/5 transition-colors"
						>
							{t("labels.clearFilter")}
						</button>
					)}
				</div>
			)}

			{/* Label manager popover */}
			{labelManagerOpen && labelManagerBtnRef.current && (
				<LabelManager
					project={project}
					labels={labels}
					dispatch={dispatch}
					onClose={() => setLabelManagerOpen(false)}
					anchorRect={labelManagerBtnRef.current.getBoundingClientRect()}
				/>
			)}

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
						bellCounts={bellCounts}
						labels={labels}
					/>
				))}
			</div>

			{showCreateModal && (
				<CreateTaskModal
					project={project}
					labels={labels}
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
