import { useEffect, useState, useCallback, type Dispatch } from "react";
import type { PortInfo, Project, Task } from "../../shared/types";
import type { AppAction, Route } from "../state";
import { api } from "../rpc";
import { useT, type TFunction } from "../i18n";
import KanbanBoard from "./KanbanBoard";
import TaskTerminal from "./TaskTerminal";
import ProjectTerminal from "./ProjectTerminal";
import TaskInfoPanel from "./TaskInfoPanel";
import SplitLayout from "./SplitLayout";
import ActiveTasksSidebar from "./ActiveTasksSidebar";

type SidebarMode = "sidebar" | "board";
const LS_SIDEBAR_MODE = "dev3-split-sidebar-mode";
const LS_PROJECT_TERMINAL_PREFIX = "dev3-project-terminal-";

function readSidebarMode(): SidebarMode {
	try {
		const v = localStorage.getItem(LS_SIDEBAR_MODE);
		if (v === "board" || v === "sidebar") return v;
	} catch { /* ignore */ }
	return "sidebar";
}

function readProjectTerminalState(projectId: string): boolean {
	try {
		return localStorage.getItem(LS_PROJECT_TERMINAL_PREFIX + projectId) === "true";
	} catch { /* ignore */ }
	return false;
}

function writeProjectTerminalState(projectId: string, open: boolean): void {
	try {
		if (open) {
			localStorage.setItem(LS_PROJECT_TERMINAL_PREFIX + projectId, "true");
		} else {
			localStorage.removeItem(LS_PROJECT_TERMINAL_PREFIX + projectId);
		}
	} catch { /* ignore */ }
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
	const [showProjectTerminal, setShowProjectTerminal] = useState(() => readProjectTerminalState(projectId));

	const toggleSidebarMode = useCallback((mode: SidebarMode) => {
		setSidebarMode(mode);
		try {
			localStorage.setItem(LS_SIDEBAR_MODE, mode);
		} catch { /* ignore */ }
	}, []);

	const toggleProjectTerminal = useCallback(() => {
		setShowProjectTerminal((prev) => {
			const next = !prev;
			writeProjectTerminalState(projectId, next);
			return next;
		});
	}, [projectId]);

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

	// Reset project terminal state when switching projects
	useEffect(() => {
		setShowProjectTerminal(readProjectTerminalState(projectId));
	}, [projectId]);

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

	if (showProjectTerminal) {
		return (
			<div className="flex-1 min-h-0 flex flex-col">
				<ProjectTerminalToolbar isOpen={showProjectTerminal} onToggle={toggleProjectTerminal} t={t} />
				<SplitLayout
					kanbanContent={
						<KanbanBoard
							project={project}
							tasks={tasks}
							dispatch={dispatch}
							navigate={navigate}
							bellCounts={bellCounts}
							taskPorts={taskPorts}
						/>
					}
					terminalContent={
						<ProjectTerminal projectId={projectId} projectPath={project.path} />
					}
					mode="board"
				/>
			</div>
		);
	}

	return (
		<div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col">
			<ProjectTerminalToolbar isOpen={showProjectTerminal} onToggle={toggleProjectTerminal} t={t} />
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

function ProjectTerminalToolbar({ isOpen, onToggle, t }: { isOpen: boolean; onToggle: () => void; t: TFunction }) {
	return (
		<div className="flex items-center px-3 py-1 border-b border-edge bg-base shrink-0">
			<button
				onClick={onToggle}
				title={isOpen ? t("projectTerminal.close") : t("projectTerminal.tooltip")}
				className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors ${
					isOpen
						? "bg-accent/15 text-accent"
						: "text-fg-3 hover:text-fg-2 hover:bg-raised-hover"
				}`}
			>
				<span
					className="text-sm leading-none"
					style={{ fontFamily: "'JetBrainsMono Nerd Font Mono'" }}
				>
					{"\u{F0489}"}
				</span>
				<span>{isOpen ? t("projectTerminal.close") : t("projectTerminal.open")}</span>
			</button>
		</div>
	);
}

export default ProjectView;
