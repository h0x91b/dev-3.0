import { useEffect, type Dispatch } from "react";
import type { CodingAgent, PortInfo, Project, Task, ResourceUsage } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api, isElectrobun } from "../rpc";
import KanbanBoard from "./KanbanBoard";
import TaskInfoPanel from "./TaskInfoPanel";
import SplitLayout from "./SplitLayout";
import ActiveTasksSidebar from "./ActiveTasksSidebar";
import { useState, useCallback } from "react";
import { useT } from "../i18n";
import ActiveTasksStrip from "./ActiveTasksStrip";
import TaskWorkspacePane from "./TaskWorkspacePane";
import { useTaskInlineDiffState } from "./task-inline-diff";

type SidebarMode = "sidebar" | "board";
const LS_SIDEBAR_MODE = "dev3-split-sidebar-mode";

function readSidebarMode(): SidebarMode {
	try {
		const v = localStorage.getItem(LS_SIDEBAR_MODE);
		if (v === "board" || v === "sidebar") return v;
	} catch { /* ignore */ }
	return "sidebar";
}

interface ProjectViewProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	taskPorts: Map<string, PortInfo[]>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
}

function ProjectView({
	projectId,
	projects,
	tasks,
	dispatch,
	navigate,
	bellCounts,
	taskPorts,
	taskResourceUsage,
	activeTaskId,
}: ProjectViewProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const inlineDiff = useTaskInlineDiffState(activeTaskId);

	const toggleSidebarMode = useCallback((mode: SidebarMode) => {
		setSidebarMode(mode);
		try {
			localStorage.setItem(LS_SIDEBAR_MODE, mode);
		} catch { /* ignore */ }
	}, []);

	useEffect(() => {
		(async () => {
			try {
				const tasks = await api.request.getTasks({ projectId });
				dispatch({ type: "setTasks", tasks });
			} catch (err) {
				console.error("Failed to load tasks:", err);
			}
		})();
	}, [projectId, dispatch]);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
	}, []);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	if (activeTaskId) {
		const activeTask = tasks.find((t) => t.id === activeTaskId);
		const isBrowserMode = !isElectrobun;

		// Browser mode: stack sidebar on top for full-width terminal
		if (isBrowserMode) {
			return (
				<div className="flex-1 min-h-0 flex flex-col">
					{activeTask && (
						<TaskInfoPanel
							task={activeTask}
							project={project}
							dispatch={dispatch}
							navigate={navigate}
							taskPorts={taskPorts}
							onOpenInlineDiff={inlineDiff.open}
						/>
					)}
					<ActiveTasksStrip
						project={project}
						tasks={tasks}
						activeTaskId={activeTaskId}
						navigate={navigate}
						agents={agents}
						bellCounts={bellCounts}
					/>
					<div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
						<TaskWorkspacePane
							projectId={projectId}
							taskId={activeTaskId}
							tasks={tasks}
							projects={projects}
							navigate={navigate}
							dispatch={dispatch}
							inlineDiffRequest={inlineDiff.request}
							onCloseInlineDiff={inlineDiff.close}
						/>
					</div>
				</div>
			);
		}

		const leftContent = sidebarMode === "sidebar" ? (
			<ActiveTasksSidebar
				project={project}
				tasks={tasks}
				allProjects={projects}
				activeTaskId={activeTaskId}
				dispatch={dispatch}
				navigate={navigate}
				agents={agents}
				bellCounts={bellCounts}
				taskPorts={taskPorts}
				onSwitchToBoard={() => toggleSidebarMode("board")}
				disableGlobalFindShortcut={inlineDiff.isOpen}
			/>
		) : (
			<KanbanBoard
				project={project}
				tasks={tasks}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
				taskPorts={taskPorts}
				taskResourceUsage={taskResourceUsage}
				activeTaskId={activeTaskId}
				onSwitchToSidebar={() => toggleSidebarMode("sidebar")}
				disableGlobalFindShortcut={inlineDiff.isOpen}
			/>
		);

		return (
			<div className="flex-1 min-h-0 flex flex-col">
				{activeTask && (
					<TaskInfoPanel
						task={activeTask}
						project={project}
						dispatch={dispatch}
						navigate={navigate}
						taskPorts={taskPorts}
						taskResourceUsage={taskResourceUsage}
						onOpenInlineDiff={inlineDiff.open}
					/>
				)}
				<SplitLayout
					kanbanContent={leftContent}
					terminalContent={
						<TaskWorkspacePane
							projectId={projectId}
							taskId={activeTaskId}
							tasks={tasks}
							projects={projects}
							navigate={navigate}
							dispatch={dispatch}
							inlineDiffRequest={inlineDiff.request}
							onCloseInlineDiff={inlineDiff.close}
						/>
					}
					mode={sidebarMode}
				/>
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
			<KanbanBoard
				project={project}
				tasks={tasks}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
				taskPorts={taskPorts}
				taskResourceUsage={taskResourceUsage}
			/>
		</div>
	);
}

export default ProjectView;
