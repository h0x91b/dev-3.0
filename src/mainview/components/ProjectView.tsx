import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject } from "react";
import type { CodingAgent, PortInfo, Project, SharedArtifact, Task, ResourceUsage } from "../../shared/types";
import { getTaskOpenMode, type AppAction, type Route } from "../state";
import type { NavigationGuard } from "../navigation-guard";
import { api } from "../rpc";
import KanbanBoard from "./KanbanBoard";
import TaskInfoPanel from "./TaskInfoPanel";
import SplitLayout from "./SplitLayout";
import ActiveTasksSidebar from "./ActiveTasksSidebar";
import { useState } from "react";
import { useT } from "../i18n";
import TaskWorkspacePane from "./TaskWorkspacePane";
import { createUnresolvedCommentsDiffRequest, useTaskInlineDiffState } from "./task-inline-diff";
import { trackDiffView } from "../analytics";
import { taskSeqLabel } from "../../shared/types";
import { useNarrowViewport } from "../hooks/useNarrowViewport";
import { CAROUSEL_MAX_WIDTH } from "./MobileBoardCarousel";

interface ProjectViewProps {
	projectId: string;
	projects: Project[];
	tasks: Task[];
	dispatch: Dispatch<AppAction>;
	navigate: (route: Route) => void;
	bellCounts: Map<string, number>;
	bellReasons?: Map<string, string[]>;
	taskPorts: Map<string, PortInfo[]>;
	taskResourceUsage?: Map<string, ResourceUsage>;
	activeTaskId?: string;
	taskView?: boolean;
	navigationGuardRef?: MutableRefObject<NavigationGuard | null>;
	artifactViewer?: { taskId: string; artifacts: SharedArtifact[]; index: number } | null;
	onCloseArtifactViewer?: () => void;
	isTerminalFullscreen?: boolean;
	onToggleTerminalFullscreen?: () => void;
	skipCopyModeReset?: boolean;
	openUnresolvedComments?: boolean;
}

function ProjectView({
	projectId,
	projects,
	tasks,
	dispatch,
	navigate,
	bellCounts,
	bellReasons,
	taskPorts,
	taskResourceUsage,
	activeTaskId,
	taskView,
	navigationGuardRef,
	artifactViewer,
	onCloseArtifactViewer,
	isTerminalFullscreen,
	onToggleTerminalFullscreen,
	skipCopyModeReset,
	openUnresolvedComments,
}: ProjectViewProps) {
	const t = useT();
	const project = projects.find((p) => p.id === projectId);
	const [agents, setAgents] = useState<CodingAgent[]>([]);
	const inlineDiff = useTaskInlineDiffState(activeTaskId);
	const isNarrow = useNarrowViewport(CAROUSEL_MAX_WIDTH);
	const taskUpdateEpochRef = useRef(0);
	const unresolvedRouteKeyRef = useRef<string | null>(null);

	const openUnresolvedFromBoard = useCallback((task: Task) => {
		if (getTaskOpenMode() === "fullscreen") {
			navigate({ screen: "task", projectId, taskId: task.id, openUnresolvedComments: true });
		} else {
			navigate({ screen: "project", projectId, activeTaskId: task.id, openUnresolvedComments: true });
		}
	}, [navigate, projectId]);

	// A scheduled launch can push its new task while this view's initial fetch is
	// in flight. Keep the live update instead of letting the older disk snapshot
	// overwrite it when the request returns.
	useEffect(() => {
		function onTaskUpdated(e: Event) {
			const { task } = (e as CustomEvent<{ task: Task }>).detail;
			if (task?.projectId === projectId) taskUpdateEpochRef.current += 1;
		}
		window.addEventListener("rpc:taskUpdated", onTaskUpdated);
		return () => window.removeEventListener("rpc:taskUpdated", onTaskUpdated);
	}, [projectId]);

	useEffect(() => {
		const taskUpdateEpoch = taskUpdateEpochRef.current;
		let cancelled = false;
		(async () => {
			try {
				const tasks = await api.request.getTasks({ projectId });
				if (!cancelled && taskUpdateEpoch === taskUpdateEpochRef.current) {
					dispatch({ type: "setTasks", projectId, tasks });
				}
			} catch (err) {
				console.error("Failed to load tasks:", err);
			}
		})();
		return () => { cancelled = true; };
	}, [projectId, dispatch]);

	useEffect(() => {
		api.request.getAgents().then(setAgents).catch(() => {});
	}, []);

	// Opening the inline diff is a distinct surface but not a route — fire its
	// page view explicitly (once per open) so it shows up alongside navigation.
	// Use the human-readable seq id (e.g. "981-1"), falling back to the raw id.
	useEffect(() => {
		if (!inlineDiff.isOpen || !activeTaskId) return;
		const task = tasks.find((t) => t.id === activeTaskId);
		trackDiffView(projectId, task ? taskSeqLabel(task) : activeTaskId);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per open
	}, [inlineDiff.isOpen, projectId, activeTaskId]);

	useEffect(() => {
		if (!openUnresolvedComments) {
			unresolvedRouteKeyRef.current = null;
			return;
		}
		if (!activeTaskId || !project) return;
		const task = tasks.find((candidate) => candidate.id === activeTaskId);
		if (!task) return;
		const routeKey = `${project.id}:${task.id}`;
		if (unresolvedRouteKeyRef.current === routeKey) return;
		unresolvedRouteKeyRef.current = routeKey;
		inlineDiff.open(createUnresolvedCommentsDiffRequest(task, project));
	}, [activeTaskId, inlineDiff.open, openUnresolvedComments, project, tasks]);

	if (!project) {
		return (
			<div className="h-full w-full flex items-center justify-center">
				<span className="text-danger text-base">{t("project.notFound")}</span>
			</div>
		);
	}

	if (activeTaskId || taskView) {
		const activeTask = activeTaskId ? tasks.find((t) => t.id === activeTaskId) : undefined;

		// Terminal pane: a selected task shows its workspace; otherwise (task-view
		// reached via a project switch with no task picked yet) an empty placeholder.
		const terminalPane = activeTaskId ? (
			<TaskWorkspacePane
				projectId={projectId}
				taskId={activeTaskId}
				tasks={tasks}
				projects={projects}
				navigate={navigate}
				dispatch={dispatch}
				inlineDiffRequest={inlineDiff.request}
				onCloseInlineDiff={inlineDiff.close}
				navigationGuardRef={navigationGuardRef}
				artifactViewer={artifactViewer}
				onCloseArtifactViewer={onCloseArtifactViewer}
				skipCopyModeReset={skipCopyModeReset}
			/>
		) : (
			<div className="h-full w-full flex items-center justify-center bg-base px-6 text-center">
				<span className="text-fg-muted text-sm">{t("project.selectTaskForTerminal")}</span>
			</div>
		);

		// Narrow (mobile) viewports keep the terminal full-width — there is no room
		// for the active-tasks split. Task switching stays available via the
		// breadcrumb/board carousel and the task-switcher overlay. Wide viewports
		// (desktop and remote/browser alike) get the standard SplitLayout below.
		if (isNarrow) {
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
							tasks={tasks}
							isTerminalFullscreen={isTerminalFullscreen}
							onToggleTerminalFullscreen={onToggleTerminalFullscreen}
							onOpenInlineDiff={inlineDiff.open}
						/>
					)}
					<div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
						{terminalPane}
					</div>
				</div>
			);
		}

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
						tasks={tasks}
						isTerminalFullscreen={isTerminalFullscreen}
						onToggleTerminalFullscreen={onToggleTerminalFullscreen}
						onOpenInlineDiff={inlineDiff.open}
					/>
				)}
				<SplitLayout
					kanbanContent={
						<ActiveTasksSidebar
							project={project}
							tasks={tasks}
							allProjects={projects}
							activeTaskId={activeTaskId}
							dispatch={dispatch}
							navigate={navigate}
							agents={agents}
							bellCounts={bellCounts}
							bellReasons={bellReasons}
							taskPorts={taskPorts}
							disableGlobalFindShortcut={inlineDiff.isOpen}
						/>
					}
					terminalContent={terminalPane}
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
				bellReasons={bellReasons}
				taskPorts={taskPorts}
				taskResourceUsage={taskResourceUsage}
				onOpenUnresolvedComments={openUnresolvedFromBoard}
			/>
		</div>
	);
}

export default ProjectView;
