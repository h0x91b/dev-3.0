import { useEffect, type Dispatch } from "react";
import type { PortInfo, Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import KanbanBoard from "./KanbanBoard";
import TaskTerminal from "./TaskTerminal";
import TaskInfoPanel from "./TaskInfoPanel";
import SplitLayout from "./SplitLayout";
import ActiveTasksSidebar from "./ActiveTasksSidebar";
import { useState, useCallback } from "react";
import { useT } from "../i18n";

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
	activeTaskId,
}: ProjectViewProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);
	const [sidebarMode, setSidebarMode] = useState<SidebarMode>(readSidebarMode);

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

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	if (activeTaskId) {
		const activeTask = tasks.find((t) => t.id === activeTaskId);

		const leftContent = sidebarMode === "sidebar" ? (
			<ActiveTasksSidebar
				project={project}
				tasks={tasks}
				activeTaskId={activeTaskId}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
				taskPorts={taskPorts}
				onSwitchToBoard={() => toggleSidebarMode("board")}
			/>
		) : (
			<KanbanBoard
				project={project}
				tasks={tasks}
				dispatch={dispatch}
				navigate={navigate}
				bellCounts={bellCounts}
				taskPorts={taskPorts}
				activeTaskId={activeTaskId}
				onSwitchToSidebar={() => toggleSidebarMode("sidebar")}
			/>
		);

		return (
			<div className="flex-1 min-h-0 flex flex-col">
				{activeTask && <TaskInfoPanel task={activeTask} project={project} dispatch={dispatch} navigate={navigate} taskPorts={taskPorts} />}
				<SplitLayout
					kanbanContent={leftContent}
					terminalContent={
						<TaskTerminal
							projectId={projectId}
							taskId={activeTaskId}
							tasks={tasks}
							projects={projects}
							navigate={navigate}
							dispatch={dispatch}
							hideInfoPanel
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
			/>
		</div>
	);
}

export default ProjectView;
